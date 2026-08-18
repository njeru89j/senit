import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import {
  AlertStatus,
  Batch,
  BatchStatus,
  LockerStatus,
  ParcelStatus,
  SealCondition,
  TamperAlertType,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class OperationsService {
  private readonly lockerAttempts = new Map<string, { count: number; lockedUntil?: Date }>();
  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationsService) {}

  private audit(userId: string | undefined, action: string, entityType: string, entityId?: string, after?: object) {
    return this.prisma.auditLog.create({ data: { userId, action, entityType, entityId, after } });
  }

  private async officerRouteIds(user?: { id: string; role: UserRole }): Promise<string[] | undefined> {
    if (!user || user.role !== UserRole.TRANSIT_OFFICER) return undefined;
    const points = await this.prisma.transitPoint.findMany({ where: { officerId: user.id, active: true }, select: { routeId: true } });
    return [...new Set(points.map((point) => point.routeId).filter((id): id is string => !!id))];
  }

  async createRoute(data: { name: string; origin: string; destination: string; transitPointIds?: string[] }, userId?: string) {
    this.validateRoute(data);
    await this.validateTransitPointIds(data.transitPointIds ?? []);
    const route = await this.prisma.$transaction(async (tx) => {
      const created = await tx.route.create({ data: { name: data.name.trim(), origin: data.origin.trim(), destination: data.destination.trim() } });
      if (data.transitPointIds?.length) await tx.routeTransitPoint.createMany({
        data: data.transitPointIds.map((transitPointId, sequence) => ({ routeId: created.id, transitPointId, sequence: sequence + 1 })),
      });
      return created;
    });
    await this.audit(userId, 'ROUTE_CREATED', 'Route', route.id, route);
    return route;
  }

  async listRoutes(user?: { id: string; role: UserRole }) {
    const allowedRouteIds = await this.officerRouteIds(user);
    const routes = await this.prisma.route.findMany({ where: allowedRouteIds ? { id: { in: allowedRouteIds } } : undefined, orderBy: { name: 'asc' } });
    const memberships = await this.prisma.routeTransitPoint.findMany({ orderBy: [{ routeId: 'asc' }, { sequence: 'asc' }] });
    const points = await this.prisma.transitPoint.findMany({
      where: { routeId: { in: routes.map((route) => route.id) } },
      orderBy: { createdAt: 'asc' },
    });
    const byId = new Map(points.map((point) => [point.id, point]));
    return routes.map((route) => ({
      ...route,
      transitPoints: [
        ...memberships
          .filter((item) => item.routeId === route.id && byId.has(item.transitPointId))
          .map((item) => ({ ...item, transitPoint: byId.get(item.transitPointId) })),
        ...points
          .filter((point) => point.routeId === route.id && !memberships.some((item) => item.routeId === route.id && item.transitPointId === point.id))
          .map((point, index) => ({ routeId: route.id, transitPointId: point.id, sequence: memberships.filter((item) => item.routeId === route.id).length + index + 1, transitPoint: point })),
      ],
    }));
  }

  async updateRoute(id: string, data: { name?: string; origin?: string; destination?: string; active?: boolean; transitPointIds?: string[] }, userId: string) {
    const existing = await this.prisma.route.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Route not found');
    if (data.transitPointIds) await this.validateTransitPointIds(data.transitPointIds);
    const updated = await this.prisma.$transaction(async (tx) => {
      const route = await tx.route.update({ where: { id }, data: {
        name: data.name?.trim(), origin: data.origin?.trim(), destination: data.destination?.trim(), active: data.active,
      }});
      if (data.transitPointIds) {
        await tx.routeTransitPoint.deleteMany({ where: { routeId: id } });
        if (data.transitPointIds.length) await tx.routeTransitPoint.createMany({ data: data.transitPointIds.map((transitPointId, sequence) => ({ routeId: id, transitPointId, sequence: sequence + 1 })) });
      }
      return route;
    });
    await this.audit(userId, 'ROUTE_UPDATED', 'Route', id, updated);
    return updated;
  }

  async createTransitPoint(data: { name: string; latitude?: number; longitude?: number; contact?: string; routeId?: string; officerId?: string }, userId?: string) {
    if (!data.routeId) throw new BadRequestException('A route is required for the transit point');
    const route = await this.prisma.route.findFirst({ where: { id: data.routeId, active: true } });
    if (!route) throw new NotFoundException('Active route not found');
    if (data.officerId) {
      const officer = await this.prisma.user.findFirst({ where: { id: data.officerId, role: UserRole.TRANSIT_OFFICER, isActive: true, deletedAt: null } });
      if (!officer) throw new NotFoundException('Active transit officer not found');
    }
    const point = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transitPoint.create({ data: { ...data, latitude: data.latitude ?? 0, longitude: data.longitude ?? 0 } });
      const lastMembership = await tx.routeTransitPoint.findFirst({
        where: { routeId: data.routeId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      await tx.routeTransitPoint.create({
        data: { routeId: data.routeId!, transitPointId: created.id, sequence: (lastMembership?.sequence ?? 0) + 1 },
      });
      return created;
    });
    await this.audit(userId, 'TRANSIT_POINT_CREATED', 'TransitPoint', point.id, point);
    return point;
  }

  listTransitPoints() {
    return this.prisma.transitPoint.findMany({ orderBy: { name: 'asc' } });
  }

  async listTransitPointsDetailed(user?: { id: string; role: UserRole }) {
    const points = await this.prisma.transitPoint.findMany({ where: user?.role === UserRole.TRANSIT_OFFICER ? { officerId: user.id, active: true } : undefined, orderBy: { name: 'asc' } });
    const routeIds = [...new Set(points.map((point) => point.routeId).filter(Boolean) as string[])];
    const officerIds = [...new Set(points.map((point) => point.officerId).filter(Boolean) as string[])];
    const [routes, officers]: [any[], any[]] = await Promise.all([
      routeIds.length ? this.prisma.route.findMany({ where: { id: { in: routeIds } } }) : [],
      officerIds.length ? this.prisma.user.findMany({ where: { id: { in: officerIds } }, select: { id: true, name: true, email: true, phone: true } }) : [],
    ]);
    return points.map((point) => ({ ...point, route: routes.find((route) => route.id === point.routeId) ?? null, officer: officers.find((officer) => officer.id === point.officerId) ?? null }));
  }

  async listOfficerCandidates() {
    return this.prisma.user.findMany({ where: { role: { in: [UserRole.CUSTOMER, UserRole.TRANSIT_OFFICER] }, isActive: true, deletedAt: null }, select: { id: true, name: true, email: true, phone: true, role: true }, orderBy: { name: 'asc' } });
  }

  async nominateTransitOfficer(userId: string, adminId: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, isActive: true, deletedAt: null } });
    if (!user) throw new NotFoundException('Active user not found');
    if (user.role === UserRole.ADMIN || user.role === UserRole.DRIVER) throw new BadRequestException('Administrators and drivers cannot be converted to transit officers');
    const updated = await this.prisma.user.update({ where: { id: userId }, data: { role: UserRole.TRANSIT_OFFICER } });
    await this.audit(adminId, 'TRANSIT_OFFICER_NOMINATED', 'User', userId, { previousRole: user.role, role: updated.role });
    return { id: updated.id, name: updated.name, email: updated.email, phone: updated.phone, role: updated.role };
  }

  async updateTransitPoint(id: string, data: { name?: string; latitude?: number; longitude?: number; contact?: string; active?: boolean; routeId?: string; officerId?: string }, userId: string) {
    const existing = await this.prisma.transitPoint.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Transit point not found');
    this.validateCoordinates(data.latitude ?? existing.latitude, data.longitude ?? existing.longitude);
    const updated = await this.prisma.transitPoint.update({ where: { id }, data: { ...data, name: data.name?.trim() } });
    await this.audit(userId, 'TRANSIT_POINT_UPDATED', 'TransitPoint', id, updated);
    return updated;
  }

  async officerWorkspace(officerId: string) {
    const points = await this.prisma.transitPoint.findMany({ where: { officerId, active: true }, orderBy: { name: 'asc' } });
    const pointIds = points.map((point) => point.id);
    const routeIds = [...new Set(points.map((point) => point.routeId).filter(Boolean) as string[])];
    const routes = routeIds.length ? await this.prisma.route.findMany({ where: { id: { in: routeIds } } }) : [];
    const events = pointIds.length ? await this.prisma.batchEvent.findMany({ where: { transitPointId: { in: pointIds }, type: 'ARRIVED_AT_TRANSIT_POINT' }, orderBy: { createdAt: 'desc' } }) : [];
    const batchIds = [...new Set(events.map((event) => event.batchId))];
    const batches = batchIds.length ? await this.prisma.batch.findMany({ where: { id: { in: batchIds }, status: BatchStatus.IN_TRANSIT } }) : [];
    const result: any[] = [];
    for (const batch of batches) {
      const arrival = events.find((event) => event.batchId === batch.id);
      if (!arrival) continue;
      const memberships = await this.prisma.batchParcel.findMany({ where: { batchId: batch.id, removedAt: null, loadedAt: { not: null } } });
      const parcels = memberships.length ? await this.prisma.parcel.findMany({ where: { id: { in: memberships.map((item) => item.parcelId) }, status: ParcelStatus.at_transit_point }, select: { id: true, trackingNumber: true, status: true, currentLocation: true, deliveryAddress: true } }) : [];
      result.push({ ...batch, transitPoint: points.find((point) => point.id === arrival.transitPointId), route: routes.find((route) => route.id === batch.routeId), parcels, arrivalAt: arrival.createdAt });
    }
    return result;
  }

  /** Parcels an officer may receive, verify, or hand over at their own transit points. */
  async officerParcels(officerId: string) {
    const points = await this.prisma.transitPoint.findMany({ where: { officerId, active: true }, select: { id: true, routeId: true } });
    const pointIds = points.map((point) => point.id);
    const routeIds = [...new Set(points.map((point) => point.routeId).filter((id): id is string => !!id))];
    return this.prisma.parcel.findMany({
      where: {
        deletedAt: null,
        status: { in: [ParcelStatus.collected, ParcelStatus.at_transit_point, ParcelStatus.at_destination] },
        OR: [{ currentTransitPointId: { in: pointIds } }, { routeId: { in: routeIds } }],
      },
      select: { id: true, trackingNumber: true, status: true, routeId: true, currentTransitPointId: true, currentLocation: true, pickupAddress: true, deliveryAddress: true, recipientName: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** Live driver details are deliberately restricted to drivers operating on the officer's routes. */
  async officerDrivers(officerId: string) {
    const routeIds = await this.officerRouteIds({ id: officerId, role: UserRole.TRANSIT_OFFICER }) ?? [];
    const batches = routeIds.length ? await this.prisma.batch.findMany({
      where: { routeId: { in: routeIds }, status: BatchStatus.IN_TRANSIT, driverId: { not: null } },
      select: { id: true, batchNumber: true, routeId: true, driverId: true, createdAt: true },
    }) : [];
    const driverIds = [...new Set(batches.map((batch) => batch.driverId).filter((id): id is string => !!id))];
    const drivers = driverIds.length ? await this.prisma.user.findMany({
      where: { id: { in: driverIds }, role: UserRole.DRIVER, deletedAt: null },
      select: { id: true, name: true, phone: true, vehicleNumber: true, vehicleType: true, currentLat: true, currentLng: true, lastActiveAt: true, isAvailable: true },
    }) : [];
    return batches.map((batch) => ({ ...batch, driver: drivers.find((driver) => driver.id === batch.driverId) ?? null }));
  }

  async officerLockerStations(officerId: string) {
    return this.listLockerStations({ id: officerId, role: UserRole.TRANSIT_OFFICER });
  }

  async searchDeliveryUsers(query: string) {
    const value = query?.trim();
    if (!value || value.length < 2) return [];
    return this.prisma.user.findMany({
      where: { role: UserRole.CUSTOMER, isActive: true, deletedAt: null, OR: [{ name: { contains: value, mode: 'insensitive' } }, { email: { contains: value, mode: 'insensitive' } }, { phone: { contains: value, mode: 'insensitive' } }] },
      select: { id: true, name: true, email: true, phone: true, address: true },
      take: 8,
      orderBy: { name: 'asc' },
    });
  }

  async addOfficerLocker(data: { compartmentNo: string; size: any }, officerId: string) {
    if (!data.compartmentNo?.trim()) throw new BadRequestException('Locker number is required');
    return this.addCompartment({ compartmentNo: data.compartmentNo.trim(), size: data.size }, officerId, UserRole.TRANSIT_OFFICER);
  }

  async inspectAndDismissBatch(batchId: string, data: { transitPointId: string; inspections: { parcelId: string; condition: SealCondition; notes?: string }[] }, officerId: string) {
    const point = await this.prisma.transitPoint.findFirst({ where: { id: data.transitPointId, officerId, active: true } });
    if (!point) throw new NotFoundException('Transit point is not assigned to this officer');
    if (!point.routeId) throw new BadRequestException('Transit point has no route assigned');
    const batch = await this.prisma.batch.findFirst({ where: { id: batchId, routeId: point.routeId, status: BatchStatus.IN_TRANSIT } });
    if (!batch) throw new NotFoundException('Active batch not found for this transit point');
    const memberships = await this.prisma.batchParcel.findMany({ where: { batchId, removedAt: null, loadedAt: { not: null } } });
    if (!data.inspections?.length || data.inspections.length !== memberships.length) throw new BadRequestException('Every physically loaded parcel must be inspected before batch dismissal');
    const expected = new Set(memberships.map((item) => item.parcelId));
    if (new Set(data.inspections.map((item) => item.parcelId)).size !== expected.size || data.inspections.some((item) => !expected.has(item.parcelId))) throw new BadRequestException('Inspection list does not match the batch parcels');
    const blocked = data.inspections.filter((item) => item.condition !== SealCondition.INTACT);
    return this.prisma.$transaction(async (tx) => {
      for (const inspection of data.inspections) {
        const decision = inspection.condition === SealCondition.INTACT ? 'CLEARED' : 'HELD';
        await tx.transitInspection.create({ data: { batchId, parcelId: inspection.parcelId, transitPointId: point.id, officerId, condition: inspection.condition, decision, notes: inspection.notes } });
        const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: inspection.parcelId } });
        await tx.parcelStatusHistory.create({ data: { parcelId: parcel.id, status: parcel.status, location: point.name, updatedBy: officerId, notes: `Transit inspection ${inspection.condition}; ${decision}${inspection.notes ? ` — ${inspection.notes}` : ''}` } });
        if (decision === 'HELD') await tx.batchParcel.updateMany({ where: { batchId, parcelId: parcel.id, removedAt: null }, data: { removedAt: new Date() } });
        else await tx.parcel.update({ where: { id: parcel.id }, data: { status: ParcelStatus.at_transit_point, currentLocation: point.name, currentTransitPointId: point.id } });
      }
      await tx.batchEvent.create({ data: { batchId, transitPointId: point.id, type: 'DEPARTED', notes: `Dismissed by transit officer; ${blocked.length} parcel(s) held`, createdBy: officerId } });
      await tx.auditLog.create({ data: { userId: officerId, action: 'BATCH_INSPECTED_AND_DISMISSED', entityType: 'Batch', entityId: batchId, after: { transitPointId: point.id, inspected: data.inspections.length, held: blocked.map((item) => item.parcelId) } } });
      return { dismissed: data.inspections.length - blocked.length, held: blocked.length };
    });
  }

  private validateRoute(data: { name: string; origin: string; destination: string }) {
    if (!data.name?.trim() || !data.origin?.trim() || !data.destination?.trim()) throw new BadRequestException('Route name, origin, and destination are required');
    if (data.origin.trim().toLowerCase() === data.destination.trim().toLowerCase()) throw new BadRequestException('Route origin and destination must be different');
  }

  private validateCoordinates(latitude: number, longitude: number) {
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new BadRequestException('Transit point coordinates are invalid');
  }

  private async validateTransitPointIds(ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new BadRequestException('A transit point cannot appear twice in one route');
    if (!ids.length) return;
    const count = await this.prisma.transitPoint.count({ where: { id: { in: ids }, active: true } });
    if (count !== ids.length) throw new BadRequestException('Every selected transit point must exist and be active');
  }

  async createBatch(data: { routeId: string; driverId?: string; parcelIds: string[] }, userId: string) {
    if (!data.parcelIds?.length) throw new BadRequestException('Select at least one parcel for the batch');
    if (new Set(data.parcelIds).size !== data.parcelIds.length) throw new BadRequestException('A parcel cannot be selected twice');
    const route = await this.prisma.route.findFirst({ where: { id: data.routeId, active: true } });
    if (!route) throw new NotFoundException('Active route not found');
    const parcels = await this.prisma.parcel.findMany({ where: { id: { in: data.parcelIds }, deletedAt: null } });
    if (parcels.length !== data.parcelIds.length) throw new BadRequestException('One or more selected parcels do not exist');
    if (parcels.some((parcel) => parcel.status !== ParcelStatus.collected && parcel.status !== ParcelStatus.at_transit_point)) throw new BadRequestException('Only collected parcels or parcels held at a transit point can be batched');
    const routePoints = await this.prisma.routeTransitPoint.findMany({ where: { routeId: route.id }, orderBy: { sequence: 'asc' } });
    const pointRecords = routePoints.length ? await this.prisma.transitPoint.findMany({ where: { id: { in: routePoints.map((item) => item.transitPointId) } } }) : [];
    const routeLocations = [route.origin, ...pointRecords.map((point) => point.name), route.destination].map((value) => value.trim().toLowerCase());
    for (const parcel of parcels) {
      const current = (parcel.currentLocation || parcel.pickupAddress).trim().toLowerCase();
      if (!routeLocations.includes(current)) throw new BadRequestException(`Parcel ${parcel.trackingNumber} cannot join this batch because its current location is not on the route`);
      if (parcel.routeId && parcel.routeId !== route.id && parcel.status === ParcelStatus.collected) throw new BadRequestException(`Parcel ${parcel.trackingNumber} is assigned to a different route`);
    }
    const activeBatches = await this.prisma.batch.findMany({ where: { status: { notIn: [BatchStatus.CLOSED, BatchStatus.SPLIT] } }, select: { id: true } });
    const activeMembership = activeBatches.length ? await this.prisma.batchParcel.findFirst({ where: { parcelId: { in: data.parcelIds }, removedAt: null, batchId: { in: activeBatches.map((batch) => batch.id) } } }) : null;
    if (activeMembership) throw new BadRequestException('A selected parcel already belongs to an active batch');
    const batch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.batch.create({ data: { batchNumber: `BAT-${new Date().getFullYear()}-${Date.now()}-${randomInt(100, 999)}`, routeId: data.routeId, driverId: data.driverId } });
      await tx.batchParcel.createMany({ data: data.parcelIds.map((parcelId) => ({ batchId: created.id, parcelId })) });
      for (const parcel of parcels) {
        await tx.parcel.update({ where: { id: parcel.id }, data: { routeId: route.id } });
        await tx.parcelStatusHistory.create({ data: { parcelId: parcel.id, status: parcel.status, updatedBy: userId, location: parcel.currentLocation || parcel.pickupAddress, notes: `Added to ${created.batchNumber}; awaiting physical load confirmation` } });
      }
      await tx.auditLog.create({ data: { userId, action: 'BATCH_CREATED', entityType: 'Batch', entityId: created.id, after: { routeId: data.routeId, parcelIds: data.parcelIds } } });
      return created;
    });
    return batch;
  }

  async verifyParcelsAtTransit(data: { routeId: string; transitPointId: string; parcelIds: string[] }, userId: string, role?: UserRole) {
    if (!data.parcelIds?.length) throw new BadRequestException('Select at least one parcel to verify');
    const route = await this.prisma.route.findFirst({ where: { id: data.routeId, active: true } });
    if (!route) throw new NotFoundException('Active route not found');
    const membership = await this.prisma.routeTransitPoint.findFirst({ where: { routeId: data.routeId, transitPointId: data.transitPointId } });
    const point = await this.prisma.transitPoint.findFirst({ where: { id: data.transitPointId, active: true } });
    if (!point) throw new NotFoundException('Active transit point not found');
    // A parcel may be handed off at a route's origin even where the point itself belongs to the inbound route.
    if (!membership && route.origin.trim().toLowerCase() !== point.name.trim().toLowerCase()) throw new BadRequestException('The selected transit point must be on, or be the origin of, the onward route');
    if (role === UserRole.TRANSIT_OFFICER && point.officerId !== userId) throw new BadRequestException('You can only verify parcels at your assigned transit point');
    const parcels = await this.prisma.parcel.findMany({ where: { id: { in: data.parcelIds }, deletedAt: null } });
    if (parcels.length !== data.parcelIds.length) throw new BadRequestException('One or more parcels could not be found');
    await this.prisma.$transaction(async (tx) => {
      for (const parcel of parcels) {
        await tx.parcel.update({ where: { id: parcel.id }, data: { routeId: data.routeId, status: ParcelStatus.at_transit_point, currentLocation: point.name, currentTransitPointId: point.id } });
        await tx.parcelStatusHistory.create({ data: { parcelId: parcel.id, status: ParcelStatus.at_transit_point, updatedBy: userId, location: point.name, notes: 'Verified at transit point in good condition' } });
      }
    });
    await this.audit(userId, 'PARCELS_VERIFIED_AT_TRANSIT', 'TransitPoint', point.id, { routeId: data.routeId, parcelIds: data.parcelIds });
    return { verified: parcels.length };
  }

  async confirmBatchLoad(batchId: string, parcelIds: string[], userId: string) {
    const batch = await this.prisma.batch.findFirst({ where: { id: batchId, status: BatchStatus.CREATED } });
    if (!batch) throw new BadRequestException('Only a batch that has not departed can be loaded');
    if (!parcelIds?.length || new Set(parcelIds).size !== parcelIds.length) throw new BadRequestException('Select each physically loaded parcel exactly once');
    const memberships = await this.prisma.batchParcel.findMany({ where: { batchId, parcelId: { in: parcelIds }, removedAt: null } });
    if (memberships.length !== parcelIds.length) throw new BadRequestException('A selected parcel is not in this batch');
    await this.prisma.$transaction(async (tx) => {
      await tx.batchParcel.updateMany({ where: { batchId, parcelId: { in: parcelIds }, removedAt: null }, data: { loadedAt: new Date(), loadedBy: userId } });
      for (const parcelId of parcelIds) {
        const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: parcelId } });
        await tx.parcelStatusHistory.create({ data: { parcelId, status: parcel.status, updatedBy: userId, location: parcel.currentLocation || parcel.pickupAddress, notes: `Physically loaded into batch ${batch.batchNumber}` } });
      }
    });
    return { loaded: parcelIds.length };
  }

  async removeFromBatch(batchId: string, parcelId: string, userId: string, reason?: string) {
    const batch = await this.prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Batch not found');
    if (batch.status !== BatchStatus.CREATED) throw new BadRequestException('A departed batch requires a controlled correction, not normal removal');
    const membership = await this.prisma.batchParcel.findFirst({ where: { batchId, parcelId, removedAt: null } });
    if (!membership) throw new NotFoundException('Parcel is not active in this batch');
    const parcel = await this.prisma.parcel.findUniqueOrThrow({ where: { id: parcelId } });
    await this.prisma.$transaction([
      this.prisma.batchParcel.update({ where: { id: membership.id }, data: { removedAt: new Date() } }),
      this.prisma.parcelStatusHistory.create({ data: { parcelId, status: parcel.status, updatedBy: userId, location: parcel.currentLocation || parcel.pickupAddress, notes: `Removed from ${batch.batchNumber} before departure${reason ? `: ${reason}` : ''}` } }),
      this.prisma.auditLog.create({ data: { userId, action: 'PARCEL_REMOVED_FROM_BATCH', entityType: 'Batch', entityId: batchId, after: { parcelId, reason } } }),
    ]);
    return { removed: true };
  }

  async recordBatchEvent(batchId: string, data: { type: string; transitPointId?: string; notes?: string }, userId: string) {
    const batch = await this.prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch || batch.status === BatchStatus.CLOSED || batch.status === BatchStatus.SPLIT) throw new BadRequestException('Batch is not active');
    const type = data.type.toUpperCase();
    if (!['DEPARTED', 'ARRIVED_AT_TRANSIT_POINT', 'ARRIVED_AT_DESTINATION'].includes(type)) throw new BadRequestException('Use DEPARTED, ARRIVED_AT_TRANSIT_POINT, or ARRIVED_AT_DESTINATION');
    const route = await this.prisma.route.findUniqueOrThrow({ where: { id: batch.routeId } });
    const routePoints = await this.prisma.routeTransitPoint.findMany({ where: { routeId: batch.routeId }, orderBy: { sequence: 'asc' } });
    const previousArrivals = await this.prisma.batchEvent.findMany({ where: { batchId, type: 'ARRIVED_AT_TRANSIT_POINT' }, orderBy: { createdAt: 'asc' } });
    if (type === 'ARRIVED_AT_TRANSIT_POINT') {
      const expected = routePoints[previousArrivals.length];
      if (!expected || expected.transitPointId !== data.transitPointId) throw new BadRequestException('This is not the expected next transit point for the batch route');
    }
    if (type === 'ARRIVED_AT_DESTINATION' && previousArrivals.length !== routePoints.length) throw new BadRequestException('The batch has not confirmed every transit point before the destination');
    const members = await this.prisma.batchParcel.findMany({ where: { batchId, removedAt: null, loadedAt: { not: null } } });
    if (!members.length) throw new BadRequestException('Confirm which parcels are physically loaded before movement');
    if (type === 'DEPARTED' && batch.status !== BatchStatus.CREATED && !(await this.prisma.batchEvent.findFirst({ where: { batchId, type: { in: ['ARRIVED_AT_TRANSIT_POINT', 'ARRIVED_AT_DESTINATION'] } }, orderBy: { createdAt: 'desc' } }))) throw new BadRequestException('Batch is already in transit');
    const point = data.transitPointId ? await this.prisma.transitPoint.findUnique({ where: { id: data.transitPointId } }) : null;
    const status = type === 'DEPARTED' ? ParcelStatus.in_transit : type === 'ARRIVED_AT_DESTINATION' ? ParcelStatus.at_destination : ParcelStatus.at_transit_point;
    const location = type === 'ARRIVED_AT_DESTINATION' ? route.destination : point?.name ?? route.origin;
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.batchEvent.create({ data: { batchId, createdBy: userId, ...data, type } });
      for (const { parcelId } of members) {
        await tx.parcel.update({ where: { id: parcelId }, data: { status, currentLocation: location, currentTransitPointId: type === 'ARRIVED_AT_TRANSIT_POINT' ? data.transitPointId : null } });
        await tx.parcelStatusHistory.create({ data: { parcelId, status, updatedBy: userId, location, notes: `Batch ${batch.batchNumber}: ${type}${data.notes ? ` — ${data.notes}` : ''}` } });
      }
      await tx.batch.update({ where: { id: batchId }, data: { status: type === 'ARRIVED_AT_DESTINATION' ? BatchStatus.CLOSED : type === 'DEPARTED' ? BatchStatus.IN_TRANSIT : batch.status, closedAt: type === 'ARRIVED_AT_DESTINATION' ? new Date() : undefined } });
      await tx.auditLog.create({ data: { userId, action: 'BATCH_EVENT_RECORDED', entityType: 'Batch', entityId: batchId, after: { eventId: event.id, type: data.type, parcelCount: members.length } } });
      return event;
    });
  }

  async listBatches(user?: { id: string; role: UserRole }) {
    const allowedRouteIds = await this.officerRouteIds(user);
    const batches = await this.prisma.batch.findMany({ where: allowedRouteIds ? { routeId: { in: allowedRouteIds } } : undefined, orderBy: { createdAt: 'desc' } });
    const counts = await this.prisma.batchParcel.groupBy({ by: ['batchId'], where: { removedAt: null }, _count: true });
    return batches.map((batch) => ({ ...batch, parcelCount: counts.find((count) => count.batchId === batch.id)?._count ?? 0 }));
  }

  async getBatch(id: string) {
    const batch = await this.prisma.batch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException('Batch not found');
    const [memberships, events] = await Promise.all([
      this.prisma.batchParcel.findMany({ where: { batchId: id }, orderBy: { addedAt: 'asc' } }),
      this.prisma.batchEvent.findMany({ where: { batchId: id }, orderBy: { createdAt: 'asc' } }),
    ]);
    const parcels = memberships.length ? await this.prisma.parcel.findMany({ where: { id: { in: memberships.map((membership) => membership.parcelId) } } }) : [];
    return { ...batch, memberships, parcels, events };
  }

  async splitBatch(batchId: string, groups: { routeId: string; parcelIds: string[] }[], userId: string) {
    if (!groups?.length || groups.some((group) => !group.parcelIds?.length)) throw new BadRequestException('Every child batch must contain parcels');
    const parent = await this.prisma.batch.findUnique({ where: { id: batchId } });
    if (!parent || parent.status === BatchStatus.CLOSED || parent.status === BatchStatus.SPLIT) throw new BadRequestException('Batch cannot be split');
    const members = await this.prisma.batchParcel.findMany({ where: { batchId, removedAt: null } });
    const selected = groups.flatMap((group) => group.parcelIds);
    if (new Set(selected).size !== selected.length) throw new BadRequestException('A parcel cannot appear in multiple child batches');
    const memberIds = new Set(members.map((member) => member.parcelId));
    if (selected.some((parcelId) => !memberIds.has(parcelId))) throw new BadRequestException('Child batches contain parcels outside the parent batch');
    if (selected.length !== members.length) throw new BadRequestException('Every active parent parcel must belong to exactly one child batch');
    const routeIds = [...new Set(groups.map((group) => group.routeId))];
    const activeRoutes = await this.prisma.route.count({ where: { id: { in: routeIds }, active: true } });
    if (activeRoutes !== routeIds.length) throw new BadRequestException('Every child batch requires an active route');
    return this.prisma.$transaction(async (tx) => {
      await tx.batch.update({ where: { id: batchId }, data: { status: BatchStatus.SPLIT, closedAt: new Date() } });
      await tx.batchParcel.updateMany({ where: { batchId, parcelId: { in: selected }, removedAt: null }, data: { removedAt: new Date() } });
      const children: Batch[] = [];
      for (const group of groups) {
        const child = await tx.batch.create({ data: { batchNumber: `BAT-${new Date().getFullYear()}-${Date.now()}-${randomInt(100, 999)}`, routeId: group.routeId, parentBatchId: parent.id, driverId: parent.driverId } });
        await tx.batchParcel.createMany({ data: group.parcelIds.map((parcelId) => ({ batchId: child.id, parcelId })) });
        children.push(child);
      }
      await tx.auditLog.create({ data: { userId, action: 'BATCH_SPLIT', entityType: 'Batch', entityId: batchId, after: { childBatchIds: children.map((child) => child.id), parcelIds: selected } } });
      return children;
    });
  }

  async createLockerStation(data: { name: string; address: string; latitude: number; longitude: number; openingHours?: string }, userId: string) {
    this.validateCoordinates(data.latitude, data.longitude);
    const station = await this.prisma.lockerStation.create({ data });
    await this.audit(userId, 'LOCKER_STATION_CREATED', 'LockerStation', station.id, station);
    return station;
  }

  async addCompartment(data: { stationId?: string; compartmentNo: string; size: any }, userId: string, role?: UserRole) {
    let stationId = data.stationId;
    if (!stationId || role === UserRole.TRANSIT_OFFICER) {
      const points = await this.prisma.transitPoint.findMany({ where: { officerId: userId, active: true } });
      if (points.length !== 1) throw new BadRequestException('A locker can be created automatically only when you are assigned to one active transit point');
      const point = points[0];
      let lockerPoint = await this.prisma.lockerStation.findFirst({ where: { transitPointId: point.id, active: true } });
      if (!lockerPoint) lockerPoint = await this.prisma.lockerStation.create({ data: { name: point.name, address: point.name, latitude: point.latitude, longitude: point.longitude, transitPointId: point.id } });
      stationId = lockerPoint.id;
    }
    const station = stationId ? await this.prisma.lockerStation.findFirst({ where: { id: stationId, active: true } }) : null;
    if (!station) throw new NotFoundException('Active locker station not found');
    const compartment = await this.prisma.lockerCompartment.create({ data: { stationId: station.id, compartmentNo: data.compartmentNo, size: data.size } });
    await this.audit(userId, 'LOCKER_COMPARTMENT_CREATED', 'LockerCompartment', compartment.id, compartment);
    return compartment;
  }

  async updateLockerCompartment(id: string, data: { compartmentNo?: string; size?: any }, userId: string) {
    const compartment = await this.prisma.lockerCompartment.findUnique({ where: { id } });
    if (!compartment) throw new NotFoundException('Locker compartment not found');
    if (compartment.status !== LockerStatus.AVAILABLE) throw new BadRequestException('Only an available locker can be edited');
    const updated = await this.prisma.lockerCompartment.update({ where: { id }, data: { compartmentNo: data.compartmentNo?.trim() || undefined, size: data.size } });
    await this.audit(userId, 'LOCKER_COMPARTMENT_UPDATED', 'LockerCompartment', id, updated);
    return updated;
  }

  async deleteLockerCompartment(id: string, userId: string) {
    const compartment = await this.prisma.lockerCompartment.findUnique({ where: { id } });
    if (!compartment) throw new NotFoundException('Locker compartment not found');
    if (compartment.status !== LockerStatus.AVAILABLE) throw new BadRequestException('Only an empty, available locker can be deleted');
    await this.prisma.lockerCompartment.delete({ where: { id } });
    await this.audit(userId, 'LOCKER_COMPARTMENT_DELETED', 'LockerCompartment', id, { stationId: compartment.stationId, compartmentNo: compartment.compartmentNo });
    return { deleted: true };
  }

  async deactivateLockerCompartment(id: string, userId: string) {
    const compartment = await this.prisma.lockerCompartment.findUnique({ where: { id } });
    if (!compartment) throw new NotFoundException('Locker compartment not found');
    if (compartment.status !== LockerStatus.AVAILABLE) throw new BadRequestException('Only an empty, available locker can be deactivated');
    const updated = await this.prisma.lockerCompartment.update({ where: { id }, data: { status: LockerStatus.OUT_OF_SERVICE } });
    await this.audit(userId, 'LOCKER_COMPARTMENT_DEACTIVATED', 'LockerCompartment', id, updated);
    return updated;
  }

  async listLockerStations(user?: { id: string; role: UserRole }) {
    const officerPoints = user?.role === UserRole.TRANSIT_OFFICER ? await this.prisma.transitPoint.findMany({ where: { officerId: user.id, active: true }, select: { id: true } }) : [];
    const stationWhere = user?.role === UserRole.TRANSIT_OFFICER ? { transitPointId: { in: officerPoints.map((point) => point.id) } } : undefined;
    const [stations, compartments, assignments] = await Promise.all([
      this.prisma.lockerStation.findMany({ where: stationWhere, orderBy: { name: 'asc' } }),
      this.prisma.lockerCompartment.findMany({ orderBy: [{ stationId: 'asc' }, { compartmentNo: 'asc' }] }),
      this.prisma.lockerAssignment.findMany({ where: { cancelledAt: null }, orderBy: { assignedAt: 'desc' } }),
    ]);
    const parcelIds = [...new Set(assignments.map((item) => item.parcelId))];
    const parcels = parcelIds.length ? await this.prisma.parcel.findMany({
      where: { id: { in: parcelIds } },
      select: { id: true, trackingNumber: true, recipientName: true, status: true },
    }) : [];
    const parcelById = new Map(parcels.map((parcel) => [parcel.id, parcel]));
    return stations.map((station) => ({
      ...station,
      compartments: compartments.filter((item) => item.stationId === station.id).map((compartment) => {
        const assignment = assignments.find((item) => item.compartmentId === compartment.id && !item.collectedAt);
        return { ...compartment, assignment: assignment ? { ...assignment, parcel: parcelById.get(assignment.parcelId) } : null };
      }),
    }));
  }

  async assignLocker(data: { parcelId: string; stationId: string; routeId?: string; transitPointId?: string; size: any; expiresInMinutes?: number }, userId: string) {
    const station = await this.prisma.lockerStation.findFirst({ where: { id: data.stationId, active: true } });
    if (!station) throw new NotFoundException('Active locker station not found');
    if (data.transitPointId && station.transitPointId && station.transitPointId !== data.transitPointId) throw new BadRequestException('The selected locker is not assigned to this transit point');
    const parcel = await this.prisma.parcel.findFirst({ where: { id: data.parcelId, deletedAt: null } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    if (data.routeId && parcel.routeId !== data.routeId) throw new BadRequestException('The selected parcel does not belong to this route');
    if (![ParcelStatus.at_destination, ParcelStatus.at_transit_point].includes(parcel.status)) throw new BadRequestException('Parcel must be verified at a transit point or be at its final destination before locker assignment');
    const current = await this.prisma.lockerAssignment.findFirst({ where: { parcelId: data.parcelId, collectedAt: null, cancelledAt: null } });
    if (current) throw new BadRequestException('Parcel already has an active locker assignment');
    const compartment = await this.prisma.lockerCompartment.findFirst({
      where: { stationId: data.stationId, size: data.size, status: LockerStatus.AVAILABLE },
    });
    if (!compartment) throw new NotFoundException('No suitable locker compartment is available');
    const code = randomInt(100000, 999999).toString();
    const assignment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.lockerAssignment.create({ data: { parcelId: data.parcelId, compartmentId: compartment.id, assignedBy: userId } });
      await tx.lockerCompartment.update({ where: { id: compartment.id }, data: { status: LockerStatus.AWAITING_COLLECTION, currentParcelId: data.parcelId } });
      await tx.collectionCode.create({
        data: {
          lockerAssignmentId: created.id,
          codeHash: await bcrypt.hash(code, 10),
          expiresAt: new Date(Date.now() + (data.expiresInMinutes ?? 1440) * 60_000),
        },
      });
      await tx.parcel.update({ where: { id: data.parcelId }, data: { status: ParcelStatus.in_locker, currentLocation: `${station.name} locker ${compartment.compartmentNo}` } });
      await tx.parcelStatusHistory.create({ data: { parcelId: data.parcelId, status: ParcelStatus.in_locker, updatedBy: userId, location: `${station.name} locker ${compartment.compartmentNo}`, notes: `Parcel placed in locker ${compartment.compartmentNo}` } });
      return created;
    });
    await this.audit(userId, 'LOCKER_ASSIGNED', 'LockerAssignment', assignment.id);
    const ownerIds = [...new Set([parcel.senderId, parcel.recipientId].filter(Boolean))];
    await Promise.all(ownerIds.map((ownerId) => this.notifications.create({
      userId: ownerId!,
      parcelId: parcel.id,
      type: 'PARCEL_DELIVERED_TO_RECIPIENT',
      title: 'Smart locker collection code',
      message: `Your parcel ${parcel.trackingNumber} is ready for collection. Use code ${code} at ${station.name}, locker ${compartment.compartmentNo}.`,
      actionUrl: `/parcels/${parcel.id}`,
    })));
    return { assignment, collectionCode: code };
  }

  async requestLocker(data: { parcelId: string; stationId?: string; size?: any }, userId: string) {
    const parcel = await this.prisma.parcel.findFirst({ where: { id: data.parcelId, recipientId: userId, deletedAt: null } });
    if (!parcel) throw new NotFoundException('Parcel not found for this recipient');
    if (parcel.status !== ParcelStatus.at_destination) throw new BadRequestException('A locker can be requested once the parcel reaches its destination');
    const open = await this.prisma.lockerRequest.findFirst({ where: { parcelId: parcel.id, status: 'PENDING' } });
    if (open) throw new BadRequestException('A locker request is already pending for this parcel');
    return this.prisma.lockerRequest.create({ data: { parcelId: parcel.id, requestedBy: userId, stationId: data.stationId, size: data.size ?? 'MEDIUM' } });
  }
  listLockerRequests() { return this.prisma.lockerRequest.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } }); }
  async approveLockerRequest(id: string, data: { stationId: string; size?: any; expiresInMinutes?: number }, adminId: string) {
    const request = await this.prisma.lockerRequest.findFirst({ where: { id, status: 'PENDING' } });
    if (!request) throw new NotFoundException('Pending locker request not found');
    const result = await this.assignLocker({ parcelId: request.parcelId, stationId: data.stationId, size: data.size ?? request.size, expiresInMinutes: data.expiresInMinutes }, adminId);
    await this.prisma.lockerRequest.update({ where: { id }, data: { status: 'APPROVED', reviewedBy: adminId, reviewedAt: new Date() } });
    return result;
  }
  async rejectLockerRequest(id: string, adminId: string) { return this.prisma.lockerRequest.update({ where: { id, status: 'PENDING' }, data: { status: 'REJECTED', reviewedBy: adminId, reviewedAt: new Date() } }); }

  async collectFromLocker(assignmentId: string, code: string, user: { id: string; role: UserRole }) {
    const attempt = this.lockerAttempts.get(assignmentId);
    if (attempt?.lockedUntil && attempt.lockedUntil > new Date()) throw new BadRequestException('Too many invalid attempts. Try again later');
    const assignment = await this.prisma.lockerAssignment.findUnique({ where: { id: assignmentId } });
    if (!assignment || assignment.collectedAt || assignment.cancelledAt) throw new NotFoundException('Active locker assignment not found');
    const parcel = await this.prisma.parcel.findUnique({ where: { id: assignment.parcelId } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    if (user.role !== UserRole.ADMIN && parcel.senderId !== user.id && parcel.recipientId !== user.id) throw new NotFoundException('Locker assignment not found');
    const token = await this.prisma.collectionCode.findFirst({ where: { lockerAssignmentId: assignmentId, usedAt: null }, orderBy: { createdAt: 'desc' } });
    if (!token || token.expiresAt < new Date() || !(await bcrypt.compare(code, token.codeHash))) {
      const count = (attempt?.count ?? 0) + 1;
      this.lockerAttempts.set(assignmentId, { count, lockedUntil: count >= 5 ? new Date(Date.now() + 15 * 60_000) : undefined });
      await this.audit(user.id, 'LOCKER_CODE_REJECTED', 'LockerAssignment', assignmentId, { attempt: count });
      throw new BadRequestException('Invalid, expired, or already-used collection code');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.collectionCode.update({ where: { id: token.id }, data: { usedAt: new Date() } });
      await tx.lockerAssignment.update({ where: { id: assignmentId }, data: { collectedAt: new Date() } });
      await tx.lockerCompartment.update({ where: { id: assignment.compartmentId }, data: { status: LockerStatus.AVAILABLE, currentParcelId: null } });
      await tx.parcel.update({ where: { id: assignment.parcelId }, data: { status: ParcelStatus.completed, actualDeliveryTime: new Date(), deliveredToRecipient: true, deliveryConfirmedAt: new Date(), deliveryConfirmedBy: user.id, completedAt: new Date(), completedBy: user.id } });
      await tx.parcelStatusHistory.create({ data: { parcelId: assignment.parcelId, status: ParcelStatus.completed, updatedBy: user.id, notes: 'Parcel collected from smart locker and completed' } });
      await tx.auditLog.create({ data: { userId: user.id, action: 'LOCKER_COLLECTION_COMPLETED', entityType: 'LockerAssignment', entityId: assignmentId, after: { parcelId: assignment.parcelId } } });
    });
    this.lockerAttempts.delete(assignmentId);
    return { collected: true };
  }

  async completeDirectDelivery(parcelId: string, user: { id: string; role: UserRole }) {
    const parcel = await this.prisma.parcel.findFirst({ where: { id: parcelId, status: ParcelStatus.at_destination, deletedAt: null } });
    if (!parcel || (user.role === UserRole.DRIVER && parcel.driverId !== user.id)) throw new NotFoundException('Parcel is not at destination or not assigned to you');
    return this.prisma.$transaction(async (tx) => {
      const delivered = await tx.parcel.update({ where: { id: parcelId }, data: { status: ParcelStatus.delivered, currentLocation: parcel.deliveryAddress, actualDeliveryTime: new Date(), deliveredToRecipient: true } });
      await tx.parcelStatusHistory.create({ data: { parcelId, status: ParcelStatus.delivered, updatedBy: user.id, location: parcel.deliveryAddress, notes: 'Parcel delivered directly to recipient' } });
      await tx.auditLog.create({ data: { userId: user.id, action: 'DIRECT_DELIVERY_COMPLETED', entityType: 'Parcel', entityId: parcelId } });
      return delivered;
    });
  }

  async completeTransitPickup(parcelId: string, user: { id: string; role: UserRole }) {
    const parcel = await this.prisma.parcel.findFirst({ where: { id: parcelId, status: ParcelStatus.at_transit_point, deletedAt: null } });
    if (!parcel || (user.role === UserRole.CUSTOMER && parcel.recipientId !== user.id)) throw new NotFoundException('Verified parcel is not available for collection at this transit point');
    return this.prisma.$transaction(async (tx) => {
      const completed = await tx.parcel.update({ where: { id: parcelId }, data: { status: ParcelStatus.completed, deliveredToRecipient: true, deliveryConfirmedAt: new Date(), deliveryConfirmedBy: user.id, completedAt: new Date(), completedBy: user.id } });
      await tx.parcelStatusHistory.create({ data: { parcelId, status: ParcelStatus.completed, updatedBy: user.id, location: parcel.currentLocation, notes: 'Parcel collected by recipient at transit point and completed' } });
      await tx.auditLog.create({ data: { userId: user.id, action: 'TRANSIT_POINT_COLLECTION_COMPLETED', entityType: 'Parcel', entityId: parcelId } });
      return completed;
    });
  }

  async createSeal(parcelId: string, userId: string) {
    const parcel = await this.prisma.parcel.findUnique({ where: { id: parcelId } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    const existing = await this.prisma.parcelSeal.findUnique({ where: { parcelId } });
    if (existing?.active) throw new BadRequestException('Parcel already has an active security seal');
    const identifier = `SEAL-${randomBytes(12).toString('hex')}`;
    return this.prisma.$transaction(async (tx) => {
      const seal = await tx.parcelSeal.create({ data: { parcelId, identifier, signedData: randomBytes(32).toString('hex'), createdBy: userId } });
      await tx.parcel.update({ where: { id: parcelId }, data: { qrSealIdentifier: identifier } });
      await tx.auditLog.create({ data: { userId, action: 'PARCEL_SEAL_CREATED', entityType: 'ParcelSeal', entityId: seal.id, after: { parcelId, identifier } } });
      return { ...seal, qrValue: JSON.stringify({ type: 'SENDIT_SEAL', parcelId, identifier }) };
    });
  }

  async scanSeal(data: { identifier: string; parcelId: string; condition: SealCondition; transitPointId?: string; imageUrl?: string; comments?: string }, user: { id: string; role: UserRole }) {
    const seal = await this.prisma.parcelSeal.findUnique({ where: { identifier: data.identifier } });
    const mismatch = !seal || seal.parcelId !== data.parcelId;
    const condition = mismatch ? SealCondition.QR_MISMATCH : data.condition;
    const parcel = await this.prisma.parcel.findUnique({ where: { id: data.parcelId } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    if (user.role === UserRole.DRIVER && parcel.driverId !== user.id) throw new NotFoundException('Parcel not found or not assigned to you');
    if (data.transitPointId) {
      const point = await this.prisma.transitPoint.findFirst({ where: { id: data.transitPointId, active: true } });
      if (!point) throw new BadRequestException('Transit point is not active');
    }
    return this.prisma.$transaction(async (tx) => {
      const alerted = mismatch || condition !== SealCondition.INTACT;
      const scan = await tx.sealScan.create({ data: { sealId: seal?.id ?? data.identifier, parcelId: data.parcelId, scannedBy: user.id, scannerRole: user.role, condition, transitPointId: data.transitPointId, imageUrl: data.imageUrl, comments: data.comments, previousStatus: parcel.status, currentStatus: parcel.status } });
      if (alerted) {
        const type = mismatch ? TamperAlertType.QR_MISMATCH : condition === SealCondition.BROKEN ? TamperAlertType.SEAL_BROKEN : TamperAlertType.SEAL_DAMAGED;
        await tx.tamperAlert.create({ data: { parcelId: data.parcelId, sealScanId: scan.id, type, details: data.comments ?? condition } });
        await tx.parcelStatusHistory.create({ data: { parcelId: data.parcelId, status: parcel.status, updatedBy: user.id, location: parcel.currentLocation, imageUrl: data.imageUrl, notes: `Security alert: ${condition}; movement location preserved` } });
      }
      await tx.auditLog.create({ data: { userId: user.id, action: 'PARCEL_SEAL_SCANNED', entityType: 'SealScan', entityId: scan.id, after: { parcelId: data.parcelId, condition, transitPointId: data.transitPointId ?? null } } });
      return scan;
    });
  }

  async parcelSecurity(parcelId: string, user: { id: string; role: UserRole }) {
    const parcel = await this.prisma.parcel.findUnique({ where: { id: parcelId } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    const allowed = user.role === UserRole.ADMIN || parcel.driverId === user.id || parcel.senderId === user.id || parcel.recipientId === user.id;
    if (!allowed) throw new NotFoundException('Parcel not found');
    const [seal, scans, alerts] = await Promise.all([
      this.prisma.parcelSeal.findUnique({ where: { parcelId } }),
      this.prisma.sealScan.findMany({ where: { parcelId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.tamperAlert.findMany({ where: { parcelId }, orderBy: { createdAt: 'asc' } }),
    ]);
    const operational = user.role === UserRole.ADMIN || user.role === UserRole.DRIVER;
    return {
      seal: seal ? { identifier: seal.identifier, active: seal.active, createdAt: seal.createdAt } : null,
      scans: scans.map((scan) => ({ condition: scan.condition, transitPointId: scan.transitPointId, createdAt: scan.createdAt, ...(operational ? { scannedBy: scan.scannedBy, comments: scan.comments, imageUrl: scan.imageUrl } : {}) })),
      alerts: alerts.map((alert) => ({ type: alert.type, status: alert.status, createdAt: alert.createdAt, resolvedAt: alert.resolvedAt, ...(operational ? { details: alert.details, investigation: alert.investigation, outcome: alert.outcome } : {}) })),
    };
  }

  listAlerts(status?: AlertStatus) {
    return this.prisma.tamperAlert.findMany({ where: status ? { status } : undefined, orderBy: { createdAt: 'desc' } });
  }

  resolveAlert(id: string, data: { status: AlertStatus; investigation?: string; outcome?: string }, userId: string) {
    return this.prisma.tamperAlert.update({ where: { id }, data: { ...data, resolvedBy: userId, resolvedAt: data.status === AlertStatus.RESOLVED ? new Date() : undefined } });
  }

  async generateForecast() {
    const start = new Date();
    start.setDate(start.getDate() - 28);
    const grouped = await this.prisma.parcel.groupBy({ by: ['deliveryAddress'], where: { createdAt: { gte: start } }, _count: true });
    const usable = grouped.filter((row) => row._count >= 4);
    if (!usable.length) return { generated: 0, forecasts: [], message: 'Insufficient history: at least four parcels per destination in the last 28 days are required' };
    const periodStart = new Date();
    const periodEnd = new Date(Date.now() + 7 * 86_400_000);
    const forecasts = await Promise.all(usable.map((row) => this.prisma.demandForecast.create({
      data: {
        destination: row.deliveryAddress,
        periodStart,
        periodEnd,
        predictedVolume: Math.ceil(row._count / 4),
        confidence: Math.min(0.95, 0.5 + row._count / 100),
        recommendedCapacity: Math.ceil((row._count / 4) * 1.2),
        model: 'four-week-moving-average-v1',
      },
    })));
    return { generated: forecasts.length, forecasts };
  }

  listForecasts() {
    return this.prisma.demandForecast.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async routeRecommendations() {
    const forecasts = await this.prisma.demandForecast.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const latest = new Map<string, typeof forecasts[number]>();
    for (const forecast of forecasts) if (forecast.destination && !latest.has(forecast.destination)) latest.set(forecast.destination, forecast);
    const routes = await this.prisma.route.findMany({ where: { active: true } });
    return [...latest.values()].map((forecast) => {
      const route = routes.find((candidate) => candidate.destination.trim().toLowerCase() === forecast.destination?.trim().toLowerCase());
      return {
        destination: forecast.destination,
        predictedVolume: forecast.predictedVolume,
        confidence: forecast.confidence,
        recommendedCapacity: forecast.recommendedCapacity,
        routeId: route?.id ?? null,
        routeName: route?.name ?? null,
        recommendation: route
          ? `Allocate ${forecast.recommendedCapacity ?? Math.ceil(forecast.predictedVolume)} slots on ${route.name}`
          : 'Create an active route for this destination',
      };
    });
  }

  async report() {
    const [users, parcels, delivered, alerts, lockers, forecasts, parcelStatuses, driverStatuses, batches, routes] = await Promise.all([
      this.prisma.user.count(), this.prisma.parcel.count(), this.prisma.parcel.count({ where: { status: { in: [ParcelStatus.delivered, ParcelStatus.completed] } } }),
      this.prisma.tamperAlert.count(), this.prisma.lockerCompartment.groupBy({ by: ['status'], _count: true }),
      this.prisma.demandForecast.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      this.prisma.parcel.groupBy({ by: ['status'], _count: true }),
      this.prisma.user.groupBy({ by: ['driverApplicationStatus'], where: { role: UserRole.DRIVER, deletedAt: null }, _count: true }),
      this.prisma.batch.groupBy({ by: ['status'], _count: true }),
      this.prisma.route.count({ where: { active: true } }),
    ]);
    return { users, parcels, delivered, deliveryRate: parcels ? Math.round((delivered / parcels) * 1000) / 10 : 0, alerts, lockers, forecasts, parcelStatuses, driverStatuses, batches, activeRoutes: routes };
  }
}
