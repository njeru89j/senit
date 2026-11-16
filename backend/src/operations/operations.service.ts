import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { AlertStatus, LockerStatus, ParcelLegStatus, SealCondition, TamperAlert, TamperAlertType, TripStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { forecastWeeklyVolume } from '../common/forecast';
import { validCoordinates } from '../common/route-planner';
import { Actor, OPEN_TRIP_STATUSES, WorkflowContext } from './workflow/workflow-context.service';
import { JourneyService } from './workflow/journey.service';
import { DispatchService } from './workflow/dispatch.service';
import { CollectionService } from './workflow/collection.service';

const ACTIVE_LEG_STATUSES: ParcelLegStatus[] = [ParcelLegStatus.PLANNED, ParcelLegStatus.AWAITING_DRIVER, ParcelLegStatus.DRIVER_ASSIGNED, ParcelLegStatus.IN_TRANSIT, ParcelLegStatus.AWAITING_VERIFICATION, ParcelLegStatus.EXCEPTION];

/**
 * Network administration (routes, transit points, lockers), security seals, alerts, forecasting and
 * reporting. The parcel journey itself lives in ./workflow.
 */
@Injectable()
export class OperationsService {
  private static readonly MAX_LOCKER_STAY_MINUTES = 72 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: WorkflowContext,
    private readonly journey: JourneyService,
    private readonly dispatch: DispatchService,
    private readonly collection: CollectionService,
  ) {}

  private audit(userId: string | undefined, action: string, entityType: string, entityId?: string, after?: object) {
    return this.prisma.auditLog.create({ data: { userId, action, entityType, entityId, after } });
  }

  private async assertOfficerLockerAccess(stationId: string, userId: string, role?: UserRole): Promise<void> {
    if (role !== UserRole.TRANSIT_OFFICER) return;
    const station = await this.prisma.lockerStation.findUnique({ where: { id: stationId }, select: { transitPointId: true } });
    const pointIds = await this.ctx.assignedPointIds(userId);
    if (!station?.transitPointId || !pointIds.includes(station.transitPointId)) throw new NotFoundException('Locker not found at your assigned transit point');
  }

  // ---------------------------------------------------------------- routes

  private async validateStops(ids: string[], distances?: (number | null)[]) {
    if (!Array.isArray(ids) || ids.length < 2) throw new BadRequestException('A route needs at least two ordered transit points: its two endpoints');
    if (new Set(ids).size !== ids.length) throw new BadRequestException('A transit point cannot appear twice in one route');
    const points = await this.prisma.transitPoint.findMany({ where: { id: { in: ids }, active: true } });
    if (points.length !== ids.length) throw new BadRequestException('Every selected transit point must exist and be active');
    if (distances && (distances.length !== ids.length || distances.some((value, index) => index > 0 && value != null && (!Number.isFinite(value) || value < 0 || value > 2000)))) {
      throw new BadRequestException('Distances must be given per stop, in kilometres from the previous stop');
    }
    return ids.map((id) => points.find((point) => point.id === id)!);
  }

  /** Routes whose stop order cannot change without breaking active trips or parcel journeys. */
  private async routeInUse(routeId: string): Promise<{ trips: number; legs: number }> {
    const [trips, legs] = await Promise.all([
      this.prisma.trip.count({ where: { routeId, status: { in: [...OPEN_TRIP_STATUSES] } } }),
      this.prisma.parcelLeg.count({ where: { routeId, status: { in: ACTIVE_LEG_STATUSES } } }),
    ]);
    return { trips, legs };
  }

  async createRoute(data: { name: string; transitPointIds: string[]; distancesKm?: (number | null)[]; active?: boolean }, userId?: string) {
    if (!data.name?.trim()) throw new BadRequestException('Route name is required');
    const points = await this.validateStops(data.transitPointIds, data.distancesKm);
    const route = await this.prisma.$transaction(async (tx) => {
      const created = await tx.route.create({ data: { name: data.name.trim(), origin: points[0].name, destination: points[points.length - 1].name, active: data.active ?? true } });
      await tx.routeTransitPoint.createMany({ data: points.map((point, index) => ({ routeId: created.id, transitPointId: point.id, sequence: index + 1, distanceFromPreviousKm: index > 0 ? data.distancesKm?.[index] ?? null : null })) });
      return created;
    });
    await this.audit(userId, 'ROUTE_CREATED', 'Route', route.id, { ...route, stops: data.transitPointIds });
    if (route.active) await this.dispatch.retryWaitingLegs();
    return route;
  }

  async listRoutes(user?: Actor) {
    const network = await this.ctx.network();
    const officerPoints = user?.role === UserRole.TRANSIT_OFFICER ? await this.ctx.assignedPointIds(user.id) : null;
    const routes = await this.prisma.route.findMany({ orderBy: { name: 'asc' } });
    const memberships = await this.prisma.routeTransitPoint.findMany({ orderBy: [{ routeId: 'asc' }, { sequence: 'asc' }] });
    const points = await this.prisma.transitPoint.findMany({ where: { id: { in: memberships.map((item) => item.transitPointId) } } });
    const openTrips = await this.prisma.trip.groupBy({ by: ['routeId'], where: { status: { in: [...OPEN_TRIP_STATUSES] } }, _count: true });
    return routes
      .filter((route) => !officerPoints || memberships.some((item) => item.routeId === route.id && officerPoints.includes(item.transitPointId)))
      .map((route) => {
        const stops = network.stops(route.id);
        return {
          ...route,
          lengthKm: Math.round(network.routeLengthKm(route.id) * 10) / 10,
          endpoints: stops.length >= 2 ? [{ id: stops[0].transitPointId, name: stops[0].name }, { id: stops[stops.length - 1].transitPointId, name: stops[stops.length - 1].name }] : [],
          openTrips: openTrips.find((item) => item.routeId === route.id)?._count ?? 0,
          transitPoints: memberships.filter((item) => item.routeId === route.id).map((item) => ({
            ...item,
            transitPoint: points.find((point) => point.id === item.transitPointId),
            distanceKnown: stops.find((stop) => stop.transitPointId === item.transitPointId)?.distanceKnown ?? false,
            hopKm: Math.round((stops.find((stop) => stop.transitPointId === item.transitPointId)?.hopKm ?? 0) * 10) / 10,
          })),
        };
      });
  }

  async updateRoute(id: string, data: { name?: string; active?: boolean; transitPointIds?: string[]; distancesKm?: (number | null)[] }, userId: string) {
    const existing = await this.prisma.route.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Route not found');
    let points: Awaited<ReturnType<OperationsService['validateStops']>> | null = null;
    if (data.transitPointIds) {
      points = await this.validateStops(data.transitPointIds, data.distancesKm);
      const current = await this.prisma.routeTransitPoint.findMany({ where: { routeId: id }, orderBy: { sequence: 'asc' } });
      const orderChanged = current.map((item) => item.transitPointId).join('|') !== data.transitPointIds.join('|');
      if (orderChanged) {
        const use = await this.routeInUse(id);
        if (use.trips || use.legs) throw new ConflictException(`This route's stops cannot change while ${use.trips} open trip(s) and ${use.legs} parcel journey leg(s) use it. Distances and the name can still be edited.`);
      }
    } else if (data.distancesKm) {
      throw new BadRequestException('Send the ordered transitPointIds together with distancesKm');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const route = await tx.route.update({
        where: { id },
        data: { name: data.name?.trim() || undefined, active: data.active, ...(points ? { origin: points[0].name, destination: points[points.length - 1].name } : {}) },
      });
      if (points) {
        await tx.routeTransitPoint.deleteMany({ where: { routeId: id } });
        await tx.routeTransitPoint.createMany({ data: points.map((point, index) => ({ routeId: id, transitPointId: point.id, sequence: index + 1, distanceFromPreviousKm: index > 0 ? data.distancesKm?.[index] ?? null : null })) });
      }
      return route;
    });
    await this.audit(userId, 'ROUTE_UPDATED', 'Route', id, { ...updated, stops: data.transitPointIds });
    if (existing.active && data.active === false) await this.journey.onRouteDeactivated(id, userId);
    if (updated.active) await this.dispatch.retryWaitingLegs();
    return updated;
  }

  // ---------------------------------------------------------------- transit points

  async createTransitPoint(data: { name: string; latitude?: number; longitude?: number; contact?: string; routeId?: string; officerId?: string; officerIds?: string[] }, userId?: string) {
    if (!data.name?.trim()) throw new BadRequestException('Transit point name is required');
    if (!validCoordinates(data.latitude, data.longitude)) throw new BadRequestException('Valid latitude and longitude are required; route distances and driver proximity depend on them');
    const route = data.routeId ? await this.prisma.route.findFirst({ where: { id: data.routeId } }) : null;
    if (data.routeId && !route) throw new NotFoundException('Route not found');
    const officerIds = [...new Set([...(data.officerIds ?? []), ...(data.officerId ? [data.officerId] : [])])];
    const officers = officerIds.length ? await this.prisma.user.findMany({ where: { id: { in: officerIds }, role: UserRole.TRANSIT_OFFICER, isActive: true, deletedAt: null } }) : [];
    if (officers.length !== officerIds.length) throw new NotFoundException('One or more active transit officers were not found');
    if (officerIds.length && await this.prisma.transitPointOfficer.findFirst({ where: { officerId: { in: officerIds } } })) throw new BadRequestException('A transit officer can only be nominated to one transit point');
    const point = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transitPoint.create({ data: { name: data.name.trim(), routeId: data.routeId, contact: data.contact, officerId: officerIds[0], latitude: data.latitude!, longitude: data.longitude! } });
      if (officerIds.length) await tx.transitPointOfficer.createMany({ data: officerIds.map((officerId) => ({ transitPointId: created.id, officerId, nominatedBy: userId })) });
      if (route) {
        // A station added to an existing route becomes an intermediate stop, before the route's far endpoint.
        const stops = await tx.routeTransitPoint.findMany({ where: { routeId: route.id }, orderBy: { sequence: 'asc' } });
        if (stops.length >= 2) {
          const last = stops[stops.length - 1];
          await tx.routeTransitPoint.update({ where: { id: last.id }, data: { sequence: last.sequence + 1 } });
          await tx.routeTransitPoint.create({ data: { routeId: route.id, transitPointId: created.id, sequence: last.sequence } });
        } else {
          await tx.routeTransitPoint.create({ data: { routeId: route.id, transitPointId: created.id, sequence: (stops.at(-1)?.sequence ?? 0) + 1 } });
        }
      }
      return created;
    });
    await this.audit(userId, 'TRANSIT_POINT_CREATED', 'TransitPoint', point.id, point);
    return point;
  }

  listTransitPoints() {
    return this.prisma.transitPoint.findMany({ orderBy: { name: 'asc' } });
  }

  async listTransitPointsDetailed(user?: Actor) {
    const assignedIds = user?.role === UserRole.TRANSIT_OFFICER ? await this.ctx.assignedPointIds(user.id) : undefined;
    const points = await this.prisma.transitPoint.findMany({ where: assignedIds ? { id: { in: assignedIds }, active: true } : undefined, orderBy: { name: 'asc' } });
    const memberships = await this.prisma.routeTransitPoint.findMany({ where: { transitPointId: { in: points.map((point) => point.id) } } });
    const routes = memberships.length ? await this.prisma.route.findMany({ where: { id: { in: [...new Set(memberships.map((item) => item.routeId))] } } }) : [];
    const assignments = await this.prisma.transitPointOfficer.findMany({ where: { transitPointId: { in: points.map((point) => point.id) } } });
    const officers = assignments.length ? await this.prisma.user.findMany({ where: { id: { in: [...new Set(assignments.map((item) => item.officerId))] } }, select: { id: true, name: true, email: true, phone: true, address: true } }) : [];
    return points.map((point) => {
      const pointRoutes = memberships.filter((item) => item.transitPointId === point.id).map((item) => routes.find((route) => route.id === item.routeId)).filter(Boolean);
      return {
        ...point,
        route: pointRoutes[0] ?? null,
        routes: pointRoutes,
        officers: officers.filter((officer) => assignments.some((item) => item.transitPointId === point.id && item.officerId === officer.id)),
        officer: officers.find((officer) => officer.id === point.officerId) ?? null,
      };
    });
  }

  async listPublicTransitPoints() {
    return this.prisma.transitPoint.findMany({ where: { active: true }, select: { id: true, name: true, latitude: true, longitude: true, routeId: true }, orderBy: { name: 'asc' } });
  }

  async listOfficerCandidates() {
    return this.prisma.user.findMany({ where: { role: { in: [UserRole.CUSTOMER, UserRole.TRANSIT_OFFICER] }, isActive: true, deletedAt: null }, select: { id: true, name: true, email: true, phone: true, role: true, address: true }, orderBy: { name: 'asc' } });
  }

  async nominateTransitOfficer(userId: string, adminId: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, isActive: true, deletedAt: null } });
    if (!user) throw new NotFoundException('Active user not found');
    if (user.role === UserRole.ADMIN || user.role === UserRole.DRIVER) throw new BadRequestException('Administrators and drivers cannot be converted to transit officers');
    const updated = await this.prisma.user.update({ where: { id: userId }, data: { role: UserRole.TRANSIT_OFFICER } });
    await this.audit(adminId, 'TRANSIT_OFFICER_NOMINATED', 'User', userId, { previousRole: user.role, role: updated.role });
    return { id: updated.id, name: updated.name, email: updated.email, phone: updated.phone, role: updated.role };
  }

  async updateTransitPoint(id: string, data: { name?: string; latitude?: number; longitude?: number; contact?: string; active?: boolean; officerId?: string; officerIds?: string[] }, userId: string) {
    const existing = await this.prisma.transitPoint.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Transit point not found');
    const latitude = data.latitude ?? existing.latitude;
    const longitude = data.longitude ?? existing.longitude;
    if ((data.latitude !== undefined || data.longitude !== undefined) && !validCoordinates(latitude, longitude)) throw new BadRequestException('Transit point coordinates are invalid');
    const { officerIds: requestedOfficerIds, ...pointData } = data;
    if (requestedOfficerIds) {
      if (!requestedOfficerIds.length) throw new BadRequestException('A transit point must have at least one nominated officer');
      if (await this.prisma.transitPointOfficer.findFirst({ where: { officerId: { in: requestedOfficerIds }, transitPointId: { not: id } } })) throw new BadRequestException('A transit officer can only be nominated to one transit point');
      await this.prisma.$transaction(async (tx) => {
        await tx.transitPointOfficer.deleteMany({ where: { transitPointId: id } });
        await tx.transitPointOfficer.createMany({ data: requestedOfficerIds.map((officerId) => ({ transitPointId: id, officerId, nominatedBy: userId })) });
      });
    }
    if (data.active === false) {
      const busy = await this.prisma.parcel.count({ where: { currentTransitPointId: id, deletedAt: null, status: { notIn: ['delivered', 'completed', 'cancelled', 'returned'] } } });
      if (busy) throw new ConflictException(`${busy} parcel(s) are held at this station; move or deliver them before deactivating it`);
    }
    const updated = await this.prisma.transitPoint.update({ where: { id }, data: { name: data.name?.trim(), latitude: pointData.latitude, longitude: pointData.longitude, contact: pointData.contact, active: pointData.active, officerId: requestedOfficerIds?.[0] ?? pointData.officerId } });
    await this.audit(userId, 'TRANSIT_POINT_UPDATED', 'TransitPoint', id, updated);
    return updated;
  }

  // ---------------------------------------------------------------- lockers

  async officerLockerStations(user: Actor, transitPointId?: string) {
    const pointIds = user.role === UserRole.ADMIN && !transitPointId ? undefined : await this.ctx.stationScope(user, transitPointId);
    return this.listLockerStations(user, pointIds);
  }

  async searchDeliveryUsers(query: string) {
    const value = query?.trim();
    if (!value || value.length < 2) return [];
    return this.prisma.user.findMany({
      where: { role: UserRole.CUSTOMER, isActive: true, deletedAt: null, OR: [{ name: { contains: value, mode: 'insensitive' } }, { email: { contains: value, mode: 'insensitive' } }, { phone: { contains: value, mode: 'insensitive' } }] },
      select: { id: true, name: true, email: true, phone: true, address: true }, take: 8, orderBy: { name: 'asc' },
    });
  }

  async addOfficerLocker(data: { compartmentNo: string; size: any; transitPointId?: string }, user: Actor) {
    if (!data.compartmentNo?.trim()) throw new BadRequestException('Locker number is required');
    return this.addCompartment({ compartmentNo: data.compartmentNo.trim(), size: data.size, transitPointId: data.transitPointId }, user.id, user.role);
  }

  async createLockerStation(data: { name: string; address: string; latitude: number; longitude: number; openingHours?: string; transitPointId?: string }, userId: string) {
    if (!validCoordinates(data.latitude, data.longitude)) throw new BadRequestException('Locker station coordinates are invalid');
    const station = await this.prisma.lockerStation.create({ data });
    await this.audit(userId, 'LOCKER_STATION_CREATED', 'LockerStation', station.id, station);
    return station;
  }

  async addCompartment(data: { stationId?: string; compartmentNo: string; size: any; transitPointId?: string }, userId: string, role?: UserRole) {
    let stationId = data.stationId;
    if (!stationId || role === UserRole.TRANSIT_OFFICER) {
      // Officers use their own station; an admin names the transit point the locker belongs to.
      const assignedIds = role === UserRole.ADMIN
        ? await this.ctx.stationScope({ id: userId, role }, data.transitPointId).then((ids) => (data.transitPointId ? ids : []))
        : await this.ctx.assignedPointIds(userId);
      const points = await this.prisma.transitPoint.findMany({ where: { id: { in: assignedIds }, active: true } });
      if (points.length !== 1) throw new BadRequestException(role === UserRole.ADMIN ? 'Choose the transit point for this locker' : 'A locker can be created automatically only when you are assigned to one active transit point');
      const point = points[0];
      let lockerPoint = await this.prisma.lockerStation.findFirst({ where: { transitPointId: point.id, active: true } });
      if (!lockerPoint) lockerPoint = await this.prisma.lockerStation.create({ data: { name: `${point.name} Lockers`, address: point.name, latitude: point.latitude, longitude: point.longitude, transitPointId: point.id } });
      stationId = lockerPoint.id;
    }
    const station = stationId ? await this.prisma.lockerStation.findFirst({ where: { id: stationId, active: true } }) : null;
    if (!station) throw new NotFoundException('Active locker station not found');
    const compartment = await this.prisma.lockerCompartment.create({ data: { stationId: station.id, compartmentNo: data.compartmentNo, size: data.size } });
    await this.audit(userId, 'LOCKER_COMPARTMENT_CREATED', 'LockerCompartment', compartment.id, compartment);
    // A new compartment may be what an overdue parcel at this station is waiting for.
    if (station.transitPointId) await this.collection.fillFreedLocker(station.transitPointId);
    return compartment;
  }

  async updateLockerCompartment(id: string, data: { compartmentNo?: string; size?: any }, userId: string, role?: UserRole) {
    const compartment = await this.prisma.lockerCompartment.findUnique({ where: { id } });
    if (!compartment) throw new NotFoundException('Locker compartment not found');
    await this.assertOfficerLockerAccess(compartment.stationId, userId, role);
    if (compartment.status !== LockerStatus.AVAILABLE) throw new BadRequestException('Only an available locker can be edited');
    const updated = await this.prisma.lockerCompartment.update({ where: { id }, data: { compartmentNo: data.compartmentNo?.trim() || undefined, size: data.size } });
    await this.audit(userId, 'LOCKER_COMPARTMENT_UPDATED', 'LockerCompartment', id, updated);
    return updated;
  }

  async deleteLockerCompartment(id: string, userId: string, role?: UserRole) {
    const compartment = await this.prisma.lockerCompartment.findUnique({ where: { id } });
    if (!compartment) throw new NotFoundException('Locker compartment not found');
    await this.assertOfficerLockerAccess(compartment.stationId, userId, role);
    if (compartment.status !== LockerStatus.AVAILABLE) throw new BadRequestException('Only an empty, available locker can be deleted');
    if (await this.prisma.lockerAssignment.count({ where: { compartmentId: id } })) throw new BadRequestException('This locker has assignment history; deactivate it instead of deleting');
    await this.prisma.lockerCompartment.delete({ where: { id } });
    await this.audit(userId, 'LOCKER_COMPARTMENT_DELETED', 'LockerCompartment', id, { stationId: compartment.stationId, compartmentNo: compartment.compartmentNo });
    return { deleted: true };
  }

  async deactivateLockerCompartment(id: string, userId: string, role?: UserRole) {
    const compartment = await this.prisma.lockerCompartment.findUnique({ where: { id } });
    if (!compartment) throw new NotFoundException('Locker compartment not found');
    await this.assertOfficerLockerAccess(compartment.stationId, userId, role);
    const updated = await this.prisma.lockerCompartment.updateMany({ where: { id, status: LockerStatus.AVAILABLE }, data: { status: LockerStatus.OUT_OF_SERVICE } });
    if (!updated.count) throw new BadRequestException('Only an empty, available locker can be deactivated');
    await this.audit(userId, 'LOCKER_COMPARTMENT_DEACTIVATED', 'LockerCompartment', id);
    return this.prisma.lockerCompartment.findUniqueOrThrow({ where: { id } });
  }

  /** Officers see only their stations' lockers; `pointIds` narrows the view (an admin choosing one station). */
  async listLockerStations(user?: Actor, pointIds?: string[]) {
    const assignedIds = pointIds ?? (user?.role === UserRole.TRANSIT_OFFICER ? await this.ctx.assignedPointIds(user.id) : undefined);
    const stationWhere = assignedIds ? { transitPointId: { in: assignedIds } } : undefined;
    const stations = await this.prisma.lockerStation.findMany({ where: stationWhere, orderBy: { name: 'asc' } });
    const [compartments, assignments] = await Promise.all([
      this.prisma.lockerCompartment.findMany({ where: { stationId: { in: stations.map((station) => station.id) } }, orderBy: [{ stationId: 'asc' }, { compartmentNo: 'asc' }] }),
      this.prisma.lockerAssignment.findMany({ where: { cancelledAt: null, collectedAt: null }, orderBy: { assignedAt: 'desc' } }),
    ]);
    const parcels = assignments.length ? await this.prisma.parcel.findMany({ where: { id: { in: [...new Set(assignments.map((item) => item.parcelId))] } }, select: { id: true, trackingNumber: true, recipientName: true, status: true } }) : [];
    return stations.map((station) => ({
      ...station,
      compartments: compartments.filter((item) => item.stationId === station.id).map((compartment) => {
        const assignment = assignments.find((item) => item.compartmentId === compartment.id);
        return { ...compartment, assignment: assignment ? { ...assignment, parcel: parcels.find((parcel) => parcel.id === assignment.parcelId) } : null };
      }),
    }));
  }

  async requestLockerExtension(assignmentId: string, requestedMinutes: number, reason: string | undefined, userId: string) {
    if (!Number.isInteger(requestedMinutes) || requestedMinutes < 60 || requestedMinutes > OperationsService.MAX_LOCKER_STAY_MINUTES) throw new BadRequestException('Extension must be between 60 minutes and 72 hours');
    const assignment = await this.prisma.lockerAssignment.findFirst({ where: { id: assignmentId, collectedAt: null, cancelledAt: null, placedAt: { not: null } } });
    if (!assignment) throw new NotFoundException('Active locker assignment not found');
    const parcel = await this.prisma.parcel.findFirst({ where: { id: assignment.parcelId, recipientId: userId } });
    if (!parcel) throw new NotFoundException('Locker assignment not found for this customer');
    if (await this.prisma.lockerExtensionRequest.findFirst({ where: { lockerAssignmentId: assignmentId, status: 'PENDING' } })) throw new BadRequestException('An extension request is already pending');
    return this.prisma.lockerExtensionRequest.create({ data: { lockerAssignmentId: assignmentId, requestedBy: userId, requestedMinutes, reason } });
  }

  async listLockerExtensionRequests(user?: Actor) {
    const requests = await this.prisma.lockerExtensionRequest.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
    if (user?.role !== UserRole.TRANSIT_OFFICER) return requests;
    const pointIds = await this.ctx.assignedPointIds(user.id);
    const assignments = await this.prisma.lockerAssignment.findMany({ where: { id: { in: requests.map((request) => request.lockerAssignmentId) } }, select: { id: true, compartmentId: true } });
    const compartments = await this.prisma.lockerCompartment.findMany({ where: { id: { in: assignments.map((item) => item.compartmentId) } }, select: { id: true, stationId: true } });
    const stations = await this.prisma.lockerStation.findMany({ where: { id: { in: compartments.map((item) => item.stationId) }, transitPointId: { in: pointIds } }, select: { id: true } });
    const stationIds = new Set(stations.map((item) => item.id));
    const allowed = new Set(assignments.filter((item) => stationIds.has(compartments.find((compartment) => compartment.id === item.compartmentId)?.stationId ?? '')).map((item) => item.id));
    return requests.filter((request) => allowed.has(request.lockerAssignmentId));
  }

  async reviewLockerExtension(id: string, approved: boolean, reviewerId: string, role?: UserRole) {
    const request = await this.prisma.lockerExtensionRequest.findFirst({ where: { id, status: 'PENDING' } });
    if (!request) throw new NotFoundException('Pending extension request not found');
    const assignment = await this.prisma.lockerAssignment.findUnique({ where: { id: request.lockerAssignmentId }, select: { compartmentId: true, assignedAt: true } });
    const compartment = assignment ? await this.prisma.lockerCompartment.findUnique({ where: { id: assignment.compartmentId }, select: { stationId: true } }) : null;
    if (!assignment || !compartment) throw new NotFoundException('Locker assignment not found');
    await this.assertOfficerLockerAccess(compartment.stationId, reviewerId, role);
    return this.prisma.$transaction(async (tx) => {
      if (approved) {
        const code = await tx.collectionCode.findFirst({ where: { lockerAssignmentId: request.lockerAssignmentId, usedAt: null }, orderBy: { createdAt: 'desc' } });
        if (!code) throw new NotFoundException('Active collection window not found');
        const base = code.expiresAt > new Date() ? code.expiresAt : new Date();
        const maximumExpiry = new Date(assignment.assignedAt.getTime() + OperationsService.MAX_LOCKER_STAY_MINUTES * 60_000);
        const requestedExpiry = new Date(base.getTime() + request.requestedMinutes * 60_000);
        if (requestedExpiry > maximumExpiry) throw new BadRequestException('A locker cannot be held for more than 72 hours from assignment');
        await tx.collectionCode.update({ where: { id: code.id }, data: { expiresAt: requestedExpiry } });
      }
      return tx.lockerExtensionRequest.update({ where: { id }, data: { status: approved ? 'APPROVED' : 'REJECTED', reviewedBy: reviewerId, reviewedAt: new Date() } });
    });
  }

  async regenerateLockerCode(assignmentId: string, userId: string, expiresInMinutes = 1440, role?: UserRole) {
    const assignment = await this.prisma.lockerAssignment.findUnique({ where: { id: assignmentId } });
    if (!assignment || assignment.collectedAt || assignment.cancelledAt || !assignment.placedAt) throw new NotFoundException('Active locker assignment not found');
    const compartment = await this.prisma.lockerCompartment.findUnique({ where: { id: assignment.compartmentId }, select: { stationId: true } });
    if (!compartment) throw new NotFoundException('Locker assignment not found');
    await this.assertOfficerLockerAccess(compartment.stationId, userId, role);
    const maximumExpiry = new Date(assignment.assignedAt.getTime() + OperationsService.MAX_LOCKER_STAY_MINUTES * 60_000);
    if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > OperationsService.MAX_LOCKER_STAY_MINUTES || new Date(Date.now() + expiresInMinutes * 60_000) > maximumExpiry) throw new BadRequestException('Code validity cannot exceed the 72-hour locker stay limit');
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000);
    await this.prisma.$transaction(async (tx) => {
      await tx.collectionCode.updateMany({ where: { lockerAssignmentId: assignmentId, usedAt: null }, data: { usedAt: new Date() } });
      await tx.collectionCode.create({ data: { lockerAssignmentId: assignmentId, codeHash: await bcrypt.hash(code, 10), expiresAt } });
      await tx.auditLog.create({ data: { userId, action: 'LOCKER_CODE_REGENERATED', entityType: 'LockerAssignment', entityId: assignmentId } });
    });
    return { assignmentId, collectionCode: code, expiresAt };
  }

  // ---------------------------------------------------------------- security

  async createSeal(parcelId: string, userId: string) {
    const parcel = await this.prisma.parcel.findUnique({ where: { id: parcelId } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    const existing = await this.prisma.parcelSeal.findUnique({ where: { parcelId } });
    if (existing?.active) throw new BadRequestException('Parcel already has an active security seal');
    const identifier = `SEAL-${randomBytes(12).toString('hex')}`;
    return this.prisma.$transaction(async (tx) => {
      const signedData = randomBytes(32).toString('hex');
      const signature = createHmac('sha256', signedData).update(`${parcelId}:${identifier}`).digest('hex');
      const qrValue = JSON.stringify({ type: 'SENDIT_SEAL', parcelId, identifier, signature });
      const seal = existing
        ? await tx.parcelSeal.update({ where: { parcelId }, data: { identifier, signedData, active: true, createdBy: userId } })
        : await tx.parcelSeal.create({ data: { parcelId, identifier, signedData, createdBy: userId } });
      await tx.parcel.update({ where: { id: parcelId }, data: { qrSealIdentifier: identifier } });
      await tx.auditLog.create({ data: { userId, action: 'PARCEL_SEAL_CREATED', entityType: 'ParcelSeal', entityId: seal.id, after: { parcelId, identifier } } });
      return { ...seal, qrValue, qrDataUrl: await QRCode.toDataURL(qrValue, { errorCorrectionLevel: 'H', margin: 1, width: 360 }) };
    });
  }

  /** Records a seal scan; problems raise an exception without changing the parcel's movement state. */
  async scanSeal(data: { identifier: string; parcelId: string; signature?: string; condition: SealCondition; transitPointId?: string; imageUrl?: string; comments?: string }, user: Actor) {
    const seal = await this.prisma.parcelSeal.findUnique({ where: { identifier: data.identifier } });
    const expectedSignature = seal ? createHmac('sha256', seal.signedData).update(`${data.parcelId}:${data.identifier}`).digest('hex') : '';
    const signatureMatches = !!seal && !!data.signature && data.signature.length === expectedSignature.length && timingSafeEqual(Buffer.from(data.signature), Buffer.from(expectedSignature));
    const mismatch = !seal || seal.parcelId !== data.parcelId || !signatureMatches;
    const condition = mismatch ? SealCondition.QR_MISMATCH : data.condition;
    const parcel = await this.prisma.parcel.findUnique({ where: { id: data.parcelId } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    if (user.role === UserRole.DRIVER && !(await this.prisma.parcelAssignment.findFirst({ where: { parcelId: parcel.id, driverId: user.id, status: { in: ['ACCEPTED', 'COLLECTED'] } } }))) throw new NotFoundException('Parcel not found or not assigned to you');
    if (data.transitPointId && !(await this.prisma.transitPoint.findFirst({ where: { id: data.transitPointId, active: true } }))) throw new BadRequestException('Transit point is not active');
    const alerted = mismatch || condition !== SealCondition.INTACT;
    const result = await this.prisma.$transaction(async (tx) => {
      const scan = await tx.sealScan.create({ data: { sealId: seal?.id ?? data.identifier, parcelId: data.parcelId, scannedBy: user.id, scannerRole: user.role, condition, transitPointId: data.transitPointId, imageUrl: data.imageUrl, comments: data.comments, previousStatus: parcel.status, currentStatus: parcel.status } });
      let alert: TamperAlert | null = null;
      if (alerted) {
        const type = mismatch ? TamperAlertType.QR_MISMATCH : condition === SealCondition.BROKEN ? TamperAlertType.SEAL_BROKEN : TamperAlertType.SEAL_DAMAGED;
        alert = (await this.ctx.raiseAlert(tx, { parcelId: data.parcelId, type, details: data.comments ?? condition, transitPointId: data.transitPointId ?? parcel.currentTransitPointId })).alert;
        await tx.tamperAlert.update({ where: { id: alert.id }, data: { sealScanId: scan.id } });
        await tx.parcelStatusHistory.create({ data: { parcelId: data.parcelId, status: parcel.status, updatedBy: user.id, location: parcel.currentLocation, imageUrl: data.imageUrl, notes: `Security alert: ${condition}; movement state preserved` } });
      }
      await tx.auditLog.create({ data: { userId: user.id, action: 'PARCEL_SEAL_SCANNED', entityType: 'SealScan', entityId: scan.id, after: { parcelId: data.parcelId, condition, transitPointId: data.transitPointId ?? null } } });
      return { scan, alert };
    });
    if (result.alert) await this.ctx.announceAlert(result.alert, parcel.trackingNumber);
    return result.scan;
  }

  async parcelSecurity(parcelId: string, user: Actor) {
    const parcel = await this.prisma.parcel.findUnique({ where: { id: parcelId } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    const driverHasIt = user.role === UserRole.DRIVER && !!(await this.prisma.parcelAssignment.findFirst({ where: { parcelId, driverId: user.id } }));
    const allowed = user.role === UserRole.ADMIN || driverHasIt || parcel.senderId === user.id || parcel.recipientId === user.id;
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

  /** Exceptions: admins see all; officers see their stations'. */
  async listAlerts(actor: Actor, status?: AlertStatus) {
    const pointIds = actor.role === UserRole.TRANSIT_OFFICER ? await this.ctx.assignedPointIds(actor.id) : null;
    const alerts = await this.prisma.tamperAlert.findMany({ where: { ...(status ? { status } : {}), ...(pointIds ? { transitPointId: { in: pointIds } } : {}) }, orderBy: { createdAt: 'desc' }, take: 300 });
    const parcels = alerts.length ? await this.prisma.parcel.findMany({ where: { id: { in: [...new Set(alerts.map((alert) => alert.parcelId))] } }, select: { id: true, trackingNumber: true, status: true, custody: true, currentLocation: true } }) : [];
    const points = alerts.length ? await this.prisma.transitPoint.findMany({ where: { id: { in: alerts.map((alert) => alert.transitPointId).filter((id): id is string => !!id) } }, select: { id: true, name: true } }) : [];
    return alerts.map((alert) => ({ ...alert, parcel: parcels.find((parcel) => parcel.id === alert.parcelId) ?? null, station: points.find((point) => point.id === alert.transitPointId)?.name ?? null }));
  }

  // ---------------------------------------------------------------- forecasting and reporting

  async generateForecast() {
    const start = new Date();
    start.setDate(start.getDate() - 28);
    const history = await this.prisma.parcel.findMany({ where: { createdAt: { gte: start } }, select: { deliveryAddress: true, createdAt: true } });
    const grouped = new Map<string, number[]>();
    for (const parcel of history) {
      const weeksAgo = Math.min(3, Math.floor((Date.now() - parcel.createdAt.getTime()) / (7 * 86_400_000)));
      const counts = grouped.get(parcel.deliveryAddress) ?? [0, 0, 0, 0];
      counts[3 - weeksAgo]++;
      grouped.set(parcel.deliveryAddress, counts);
    }
    const usable = [...grouped.entries()].filter(([, counts]) => counts.reduce((sum, value) => sum + value, 0) >= 4);
    if (!usable.length) return { generated: 0, forecasts: [], message: 'Insufficient history: at least four parcels per destination in the last 28 days are required' };
    const periodStart = new Date();
    const periodEnd = new Date(Date.now() + 7 * 86_400_000);
    await this.prisma.demandForecast.deleteMany({ where: { periodStart: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } });
    const forecasts = await Promise.all(usable.map(([destination, counts]) => this.prisma.demandForecast.create({ data: { destination, periodStart, periodEnd, ...forecastWeeklyVolume(counts), model: 'four-week-recency-weighted-v2' } })));
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
      const route = routes.find((candidate) => [candidate.destination, candidate.origin].some((end) => end.trim().toLowerCase() === forecast.destination?.trim().toLowerCase()));
      return {
        destination: forecast.destination, predictedVolume: forecast.predictedVolume, confidence: forecast.confidence, recommendedCapacity: forecast.recommendedCapacity,
        routeId: route?.id ?? null, routeName: route?.name ?? null,
        recommendation: route ? `Allocate ${forecast.recommendedCapacity ?? Math.ceil(forecast.predictedVolume)} slots on ${route.name}` : 'Create an active route for this destination',
      };
    });
  }

  async report() {
    const [users, parcels, delivered, alerts, lockers, forecasts, parcelStatuses, driverStatuses, trips, routes, legs] = await Promise.all([
      this.prisma.user.count(), this.prisma.parcel.count(), this.prisma.parcel.count({ where: { status: { in: ['delivered', 'completed'] } } }),
      this.prisma.tamperAlert.count({ where: { status: { not: AlertStatus.RESOLVED } } }), this.prisma.lockerCompartment.groupBy({ by: ['status'], _count: true }),
      this.prisma.demandForecast.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      this.prisma.parcel.groupBy({ by: ['status'], _count: true }),
      this.prisma.user.groupBy({ by: ['driverApplicationStatus'], where: { role: UserRole.DRIVER, deletedAt: null }, _count: true }),
      this.prisma.trip.groupBy({ by: ['status'], _count: true }),
      this.prisma.route.count({ where: { active: true } }),
      this.prisma.parcelLeg.groupBy({ by: ['status'], _count: true }),
    ]);
    return { users, parcels, delivered, deliveryRate: parcels ? Math.round((delivered / parcels) * 1000) / 10 : 0, alerts, lockers, forecasts, parcelStatuses, driverStatuses, trips, batches: trips, legs, activeRoutes: routes, openTrips: trips.filter((item) => item.status === TripStatus.CREATED || item.status === TripStatus.IN_TRANSIT).reduce((sum, item) => sum + item._count, 0) };
  }
}
