import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AlertStatus, NotificationType, Parcel, ParcelStatus, Prisma, TamperAlertType, UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { DriversGateway } from '../../drivers/drivers.gateway';
import { RouteNetwork } from '../../common/route-planner';

export type Actor = { id: string; role: UserRole };
export type Tx = Prisma.TransactionClient;
export type Notice = { title: string; message: string; type: NotificationType; parcelId?: string; actionUrl?: string };

/** Interactive transactions that take row locks get room for a busy database. */
export const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;
export const SYSTEM_ACTOR = 'system';

/** Assignment states that hold vehicle capacity (reserved or loaded). */
export const CAPACITY_STATUSES = ['ASSIGNED', 'ACCEPTED', 'COLLECTED'] as const;
export const OPEN_TRIP_STATUSES = ['CREATED', 'IN_TRANSIT'] as const;

/**
 * Shared plumbing for the parcel workflow: the route network, station scoping, append-only history,
 * notifications, realtime events and exception alerts. Side effects that leave the database
 * (notifications, sockets) never throw into the workflow.
 */
@Injectable()
export class WorkflowContext {
  private readonly logger = new Logger(WorkflowContext.name);

  constructor(
    readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly gateway: DriversGateway,
  ) {}

  async network(db: Tx | PrismaService = this.prisma): Promise<RouteNetwork> {
    const [routes, memberships, points] = await Promise.all([
      db.route.findMany({ select: { id: true, name: true, active: true } }),
      db.routeTransitPoint.findMany({ select: { routeId: true, transitPointId: true, sequence: true, distanceFromPreviousKm: true } }),
      db.transitPoint.findMany({ select: { id: true, name: true, latitude: true, longitude: true, active: true } }),
    ]);
    return new RouteNetwork(routes, memberships, points);
  }

  /** Routes at least one active, approved driver serves (used as a planning tie-breaker). */
  async servedRouteIds(): Promise<Set<string>> {
    const profiles = await this.prisma.driverProfile.findMany({
      where: { approvalStatus: { in: ['APPROVED', 'ACTIVE'] }, user: { isActive: true, deletedAt: null, role: UserRole.DRIVER } },
      select: { routesServed: true },
    });
    return new Set(profiles.flatMap((profile) => profile.routesServed));
  }

  async assignedPointIds(officerId: string): Promise<string[]> {
    const assignments = await this.prisma.transitPointOfficer.findMany({ where: { officerId }, select: { transitPointId: true } });
    if (assignments.length) return assignments.map((item) => item.transitPointId);
    const legacy = await this.prisma.transitPoint.findMany({ where: { officerId }, select: { id: true } });
    return legacy.map((point) => point.id);
  }

  /** Stations an actor may operate: an officer's own stations, or every active station (or the one chosen) for an admin. */
  async stationScope(actor: Actor, transitPointId?: string): Promise<string[]> {
    if (actor.role === UserRole.ADMIN) {
      const points = await this.prisma.transitPoint.findMany({ where: { active: true, ...(transitPointId ? { id: transitPointId } : {}) }, select: { id: true } });
      if (transitPointId && !points.length) throw new NotFoundException('Active transit point not found');
      return points.map((point) => point.id);
    }
    if (actor.role !== UserRole.TRANSIT_OFFICER) return [];
    const assigned = await this.assignedPointIds(actor.id);
    if (!transitPointId) return assigned;
    if (!assigned.includes(transitPointId)) throw new NotFoundException('Transit point is not assigned to you');
    return [transitPointId];
  }

  /** Officers act only at their own stations; admins act anywhere. */
  async assertStation(actor: Actor, transitPointId: string | null | undefined, message = 'This parcel is not at your assigned transit point'): Promise<void> {
    if (actor.role === UserRole.ADMIN) return;
    if (actor.role !== UserRole.TRANSIT_OFFICER || !transitPointId || !(await this.assignedPointIds(actor.id)).includes(transitPointId)) {
      throw new NotFoundException(message);
    }
  }

  async officerIds(transitPointIds: (string | null | undefined)[]): Promise<string[]> {
    const ids = [...new Set(transitPointIds.filter((id): id is string => !!id))];
    if (!ids.length) return [];
    const [assigned, legacy] = await Promise.all([
      this.prisma.transitPointOfficer.findMany({ where: { transitPointId: { in: ids } }, select: { officerId: true } }),
      this.prisma.transitPoint.findMany({ where: { id: { in: ids }, officerId: { not: null } }, select: { officerId: true } }),
    ]);
    const officerIds = [...new Set([...assigned.map((item) => item.officerId), ...legacy.map((item) => item.officerId!)])];
    if (!officerIds.length) return [];
    const active = await this.prisma.user.findMany({ where: { id: { in: officerIds }, isActive: true, deletedAt: null, role: UserRole.TRANSIT_OFFICER }, select: { id: true } });
    return active.map((user) => user.id);
  }

  async adminIds(): Promise<string[]> {
    const admins = await this.prisma.user.findMany({ where: { role: UserRole.ADMIN, isActive: true, deletedAt: null }, select: { id: true } });
    return admins.map((admin) => admin.id);
  }

  async notifyUsers(userIds: (string | null | undefined)[], notice: Notice): Promise<void> {
    const ids = [...new Set(userIds.filter((id): id is string => !!id))];
    await Promise.all(ids.map(async (userId) => {
      try {
        await this.notifications.create({ userId, ...notice });
      } catch (error) {
        this.logger.warn(`Notification to ${userId} failed: ${error instanceof Error ? error.message : error}`);
      }
    }));
  }

  async notifyStation(transitPointIds: (string | null | undefined)[], notice: Notice): Promise<void> {
    await this.notifyUsers(await this.officerIds(transitPointIds), notice);
  }

  /** Registered sender and recipient of a parcel. */
  async notifyParties(parcel: Pick<Parcel, 'id' | 'senderId' | 'recipientId'>, notice: Omit<Notice, 'parcelId' | 'actionUrl'>): Promise<void> {
    await this.notifyUsers([parcel.senderId, parcel.recipientId], { ...notice, parcelId: parcel.id, actionUrl: `/parcels/${parcel.id}` });
  }

  emit(event: 'assignmentUpdate' | 'tripUpdate' | 'stationWorkUpdate' | 'parcelStatusUpdate', payload: object, audience: { userIds?: (string | null | undefined)[]; transitPointIds?: (string | null | undefined)[] }): void {
    try {
      this.gateway.emitWorkflowEvent(event, payload, audience);
    } catch (error) {
      this.logger.warn(`Realtime ${event} failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Append-only parcel history. */
  history(tx: Tx, data: { parcelId: string; status: ParcelStatus; location?: string | null; updatedBy?: string | null; notes: string }) {
    return tx.parcelStatusHistory.create({ data: { ...data, updatedBy: data.updatedBy && data.updatedBy !== SYSTEM_ACTOR ? data.updatedBy : null } });
  }

  audit(tx: Tx, data: { userId?: string | null; action: string; entityType: string; entityId?: string; after?: object }) {
    return tx.auditLog.create({ data: { ...data, userId: data.userId && data.userId !== SYSTEM_ACTOR ? data.userId : null, after: data.after as Prisma.InputJsonValue } });
  }

  /** Opens an exception once: an equivalent open alert for the same parcel is reused. */
  async raiseAlert(tx: Tx, data: { parcelId: string; type: TamperAlertType; details: string; transitPointId?: string | null; legId?: string | null; tripId?: string | null; assignmentId?: string | null }) {
    const existing = await tx.tamperAlert.findFirst({
      where: { parcelId: data.parcelId, type: data.type, status: { in: [AlertStatus.OPEN, AlertStatus.UNDER_INVESTIGATION, AlertStatus.ESCALATED] }, ...(data.assignmentId ? { assignmentId: data.assignmentId } : {}) },
    });
    if (existing) return { alert: existing, created: false };
    const alert = await tx.tamperAlert.create({ data: { ...data, transitPointId: data.transitPointId ?? null, legId: data.legId ?? null, tripId: data.tripId ?? null, assignmentId: data.assignmentId ?? null } });
    return { alert, created: true };
  }

  /** Closes automatically-resolvable alerts once the underlying condition is gone. */
  resolveAlerts(tx: Tx, parcelId: string, types: TamperAlertType[], outcome: string, userId?: string) {
    return tx.tamperAlert.updateMany({
      where: { parcelId, type: { in: types }, status: { not: AlertStatus.RESOLVED } },
      data: { status: AlertStatus.RESOLVED, outcome, resolvedAt: new Date(), resolvedBy: userId && userId !== SYSTEM_ACTOR ? userId : null },
    });
  }

  /** Staff are told about new exceptions at the station and in the admin queue. */
  async announceAlert(alert: { id: string; parcelId: string; type: TamperAlertType; details: string; transitPointId: string | null }, trackingNumber: string) {
    const notice: Notice = { title: `Exception: ${alert.type.replaceAll('_', ' ').toLowerCase()}`, message: `${trackingNumber}: ${alert.details}`, type: NotificationType.PARCEL_EXCEPTION, parcelId: alert.parcelId, actionUrl: '/transit-officer/dashboard' };
    await this.notifyUsers([...(await this.officerIds([alert.transitPointId])), ...(await this.adminIds())], notice);
    this.emit('stationWorkUpdate', { kind: 'EXCEPTION', alertId: alert.id, parcelId: alert.parcelId, transitPointId: alert.transitPointId }, { transitPointIds: [alert.transitPointId] });
  }

  async pointName(transitPointId: string | null | undefined, db: Tx | PrismaService = this.prisma): Promise<string> {
    if (!transitPointId) return 'Unknown station';
    return (await db.transitPoint.findUnique({ where: { id: transitPointId }, select: { name: true } }))?.name ?? 'Unknown station';
  }

  /** Row lock inside an interactive transaction; callers lock parcel legs before drivers to avoid deadlocks. */
  async lock(tx: Tx, table: 'parcel_legs' | 'users' | 'parcels' | 'parcel_assignments' | 'batches', id: string): Promise<void> {
    await tx.$queryRawUnsafe(`SELECT 1 FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);
  }
}
