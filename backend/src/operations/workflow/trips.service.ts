import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, CustodyHolder, NotificationType, ParcelLegStatus, ParcelStatus, TamperAlertType, TripStatus, UserRole } from '@prisma/client';
import { randomInt } from 'crypto';
import { RouteNetwork } from '../../common/route-planner';
import { DispatchService } from './dispatch.service';
import { vehicleCapacityKg } from './dispatch-rules';
import { Actor, OPEN_TRIP_STATUSES, TX_OPTIONS, WorkflowContext } from './workflow-context.service';

const OPEN = [...OPEN_TRIP_STATUSES] as TripStatus[];

/**
 * A driver's trip over one route in one direction. Progress is the stop the vehicle is at (or last
 * left); it decides which pickups are still ahead. Stop activities are derived from assignments.
 */
@Injectable()
export class TripsService {
  constructor(private readonly ctx: WorkflowContext, private readonly dispatch: DispatchService) {}

  private get prisma() { return this.ctx.prisma; }

  private async ownTrip(tripId: string, driverId: string) {
    const trip = await this.prisma.trip.findFirst({ where: { id: tripId, driverId } });
    if (!trip) throw new NotFoundException('Trip not found');
    return trip;
  }

  private position(network: RouteNetwork, trip: { routeId: string; direction: 'FORWARD' | 'REVERSE'; currentTransitPointId: string | null; startTransitPointId: string | null }) {
    const stops = network.stops(trip.routeId, trip.direction);
    const current = stops.findIndex((stop) => stop.transitPointId === (trip.currentTransitPointId ?? trip.startTransitPointId));
    return { stops, current: current < 0 ? 0 : current };
  }

  /** Opens a trip from one endpoint of an approved route; the direction follows from the start endpoint. */
  async openTrip(driverId: string, data: { routeId: string; startTransitPointId: string }) {
    const driver = await this.prisma.user.findFirst({ where: { id: driverId, role: UserRole.DRIVER, isActive: true, deletedAt: null }, include: { driverProfile: true } });
    if (!driver?.driverProfile || !['APPROVED', 'ACTIVE'].includes(driver.driverProfile.approvalStatus)) throw new BadRequestException('Only active, approved drivers can open a trip');
    if (!data?.routeId || !data?.startTransitPointId) throw new BadRequestException('Choose a route and the endpoint you are starting from');
    if (!driver.driverProfile.routesServed.includes(data.routeId)) throw new BadRequestException('Choose one of your approved routes');
    const network = await this.ctx.network();
    if (!network.isRouteUsable(data.routeId)) throw new BadRequestException('That route is not active');
    const direction = network.directionFrom(data.routeId, data.startTransitPointId);
    if (!direction) throw new BadRequestException('A trip must start at one of the route\'s endpoints');
    const ends = network.endpoints(data.routeId)!;
    const endId = direction === 'FORWARD' ? ends[1] : ends[0];

    const existing = await this.prisma.trip.findFirst({ where: { driverId, status: { in: OPEN } } });
    if (existing) {
      if (existing.routeId === data.routeId && existing.startTransitPointId === data.startTransitPointId) return this.workspace(driverId);
      throw new ConflictException('Finish or cancel your current trip before opening another one');
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const trip = await tx.trip.create({
          data: {
            tripNumber: `TRP-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}-${randomInt(100, 1000)}`,
            routeId: data.routeId, driverId, direction, startTransitPointId: data.startTransitPointId, endTransitPointId: endId,
            currentTransitPointId: data.startTransitPointId, atStop: true, status: TripStatus.CREATED,
          },
        });
        await tx.tripEvent.create({ data: { tripId: trip.id, transitPointId: data.startTransitPointId, type: 'OPENED', notes: `Trip opened at ${network.point(data.startTransitPointId)?.name} toward ${network.point(endId)?.name}`, createdBy: driverId } });
        await tx.driverProfile.update({ where: { userId: driverId }, data: { currentRouteId: data.routeId } });
        await tx.user.update({ where: { id: driverId }, data: { isAvailable: true } });
        await this.ctx.audit(tx, { userId: driverId, action: 'TRIP_OPENED', entityType: 'Trip', entityId: trip.id, after: { routeId: data.routeId, direction } });
      }, TX_OPTIONS);
    } catch (error: any) {
      if (error?.code === 'P2002') throw new ConflictException('You already have an open trip');
      throw error;
    }
    this.ctx.emit('tripUpdate', { driverId, status: TripStatus.CREATED, routeId: data.routeId }, { userIds: [driverId], transitPointIds: network.stops(data.routeId).map((stop) => stop.transitPointId) });
    // A new trip on the network may be the driver waiting parcels need.
    await this.dispatch.retryWaitingLegs();
    return this.workspace(driverId);
  }

  /** START DELIVERY: the vehicle leaves its start endpoint with what is physically collected. */
  async startTrip(tripId: string, driverId: string) {
    const trip = await this.ownTrip(tripId, driverId);
    if (trip.status === TripStatus.IN_TRANSIT) return this.workspace(driverId);
    if (trip.status !== TripStatus.CREATED) throw new ConflictException(`This trip is ${trip.status.toLowerCase()} and cannot start`);
    const network = await this.ctx.network();
    const start = network.point(trip.startTransitPointId ?? '')?.name ?? 'start';
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.trip.updateMany({ where: { id: tripId, driverId, status: TripStatus.CREATED }, data: { status: TripStatus.IN_TRANSIT, startedAt: new Date(), atStop: false, currentTransitPointId: trip.startTransitPointId } });
      if (!updated.count) return null;
      const onboard = await tx.parcelAssignment.findMany({ where: { tripId, status: AssignmentStatus.COLLECTED } });
      for (const assignment of onboard) {
        const moved = await tx.parcel.updateMany({ where: { id: assignment.parcelId, status: ParcelStatus.collected }, data: { status: ParcelStatus.in_transit } });
        if (moved.count) await this.ctx.history(tx, { parcelId: assignment.parcelId, status: ParcelStatus.in_transit, location: start, updatedBy: driverId, notes: `Trip ${trip.tripNumber} started; departed ${start}.` });
      }
      // Uncollected parcels waiting at the start station are now behind the vehicle.
      const behind = await tx.parcelAssignment.findMany({ where: { tripId, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] }, leg: { fromTransitPointId: trip.startTransitPointId ?? '' } } });
      await tx.tripEvent.create({ data: { tripId, transitPointId: trip.startTransitPointId, type: 'STARTED', notes: `Departed ${start} with ${onboard.length} parcel(s)`, createdBy: driverId } });
      await this.ctx.audit(tx, { userId: driverId, action: 'TRIP_STARTED', entityType: 'Trip', entityId: tripId, after: { parcels: onboard.map((item) => item.parcelId) } });
      return { onboard, behind };
    }, TX_OPTIONS);
    if (!result) return this.workspace(driverId);
    await this.dispatch.cancelBySystem(result.behind.map((item) => item.id), 'PICKUP_PASSED');
    const parcels = await this.prisma.parcel.findMany({ where: { id: { in: result.onboard.map((item) => item.parcelId) } } });
    for (const parcel of parcels) await this.ctx.notifyParties(parcel, { title: 'Parcel in transit', message: `${parcel.trackingNumber} left ${start} and is on its way.`, type: NotificationType.PARCEL_IN_TRANSIT });
    this.ctx.emit('tripUpdate', { tripId, status: TripStatus.IN_TRANSIT, driverId }, { userIds: [driverId, ...parcels.flatMap((parcel) => [parcel.senderId, parcel.recipientId])], transitPointIds: network.stops(trip.routeId).map((stop) => stop.transitPointId) });
    return this.workspace(driverId);
  }

  /** The vehicle reached a stop ahead. Skipping a stop where parcels must be dropped is refused. */
  async arrive(tripId: string, driverId: string, transitPointId: string) {
    const trip = await this.ownTrip(tripId, driverId);
    if (trip.status !== TripStatus.IN_TRANSIT) throw new ConflictException('Start the trip before recording arrivals');
    const network = await this.ctx.network();
    const { stops, current } = this.position(network, trip);
    const target = stops.findIndex((stop) => stop.transitPointId === transitPointId);
    if (target < 0) throw new BadRequestException('That station is not on this trip\'s route');
    if (target === current && trip.atStop) return this.workspace(driverId);
    if (target <= current) throw new BadRequestException('That station is behind the vehicle');
    const onboard = await this.prisma.parcelAssignment.findMany({ where: { tripId, status: AssignmentStatus.COLLECTED }, include: { leg: true } });
    const missedDrop = onboard.find((item) => {
      const drop = stops.findIndex((stop) => stop.transitPointId === item.leg?.toTransitPointId);
      return drop >= 0 && drop < target;
    });
    if (missedDrop) throw new BadRequestException(`Parcels are due to be dropped at ${network.point(missedDrop.leg!.toTransitPointId)?.name}; stop there first`);
    const passedIds = stops.slice(0, target).map((stop) => stop.transitPointId);
    const behind = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.trip.updateMany({ where: { id: tripId, status: TripStatus.IN_TRANSIT, currentTransitPointId: trip.currentTransitPointId, atStop: trip.atStop }, data: { currentTransitPointId: transitPointId, atStop: true } });
      if (!moved.count) throw new ConflictException('The trip moved on in the meantime; refresh and try again');
      await tx.tripEvent.create({ data: { tripId, transitPointId, type: 'ARRIVED', notes: `Arrived at ${stops[target].name}`, createdBy: driverId } });
      return tx.parcelAssignment.findMany({ where: { tripId, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] }, leg: { fromTransitPointId: { in: passedIds } } } });
    }, TX_OPTIONS);
    await this.dispatch.cancelBySystem(behind.map((item) => item.id), 'PICKUP_PASSED');
    this.ctx.emit('tripUpdate', { tripId, status: TripStatus.IN_TRANSIT, driverId, currentTransitPointId: transitPointId, atStop: true }, { userIds: [driverId], transitPointIds: [transitPointId] });
    this.ctx.emit('stationWorkUpdate', { kind: 'DRIVER_ARRIVED', tripId, transitPointId }, { transitPointIds: [transitPointId] });
    return this.workspace(driverId);
  }

  /** The vehicle leaves the stop it is at. Parcels due here must be dropped first. */
  async depart(tripId: string, driverId: string) {
    const trip = await this.ownTrip(tripId, driverId);
    if (trip.status !== TripStatus.IN_TRANSIT) throw new ConflictException('Start the trip first');
    if (!trip.atStop) return this.workspace(driverId);
    if (trip.currentTransitPointId === trip.endTransitPointId) throw new BadRequestException('This is the route endpoint; complete the trip instead');
    const undropped = await this.prisma.parcelAssignment.count({ where: { tripId, status: AssignmentStatus.COLLECTED, leg: { toTransitPointId: trip.currentTransitPointId ?? '' } } });
    if (undropped) throw new BadRequestException(`Drop the ${undropped} parcel(s) due at this station before departing`);
    const here = await this.ctx.pointName(trip.currentTransitPointId);
    const behind = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.trip.updateMany({ where: { id: tripId, status: TripStatus.IN_TRANSIT, currentTransitPointId: trip.currentTransitPointId, atStop: true }, data: { atStop: false } });
      if (!moved.count) return [];
      await tx.tripEvent.create({ data: { tripId, transitPointId: trip.currentTransitPointId, type: 'DEPARTED', notes: `Departed ${here}`, createdBy: driverId } });
      return tx.parcelAssignment.findMany({ where: { tripId, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] }, leg: { fromTransitPointId: trip.currentTransitPointId ?? '' } } });
    }, TX_OPTIONS);
    await this.dispatch.cancelBySystem(behind.map((item) => item.id), 'PICKUP_PASSED');
    this.ctx.emit('tripUpdate', { tripId, status: TripStatus.IN_TRANSIT, driverId, currentTransitPointId: trip.currentTransitPointId, atStop: false }, { userIds: [driverId], transitPointIds: [trip.currentTransitPointId] });
    return this.workspace(driverId);
  }

  /** COLLECT: the driver physically receives an accepted parcel at its pickup station. */
  async collect(assignmentId: string, driverId: string) {
    const assignment = await this.prisma.parcelAssignment.findFirst({ where: { id: assignmentId, driverId }, include: { leg: true, trip: true } });
    if (!assignment?.leg || !assignment.trip) throw new NotFoundException('Assignment not found');
    if (assignment.status === AssignmentStatus.COLLECTED) return this.workspace(driverId);
    if (assignment.status === AssignmentStatus.ASSIGNED) throw new ConflictException('Accept the assignment before collecting the parcel');
    if (assignment.status !== AssignmentStatus.ACCEPTED) throw new ConflictException(`This assignment is ${assignment.status.toLowerCase()}; the parcel cannot be collected`);
    const trip = assignment.trip;
    if (!OPEN.includes(trip.status)) throw new ConflictException('Your trip is no longer open');
    if (trip.currentTransitPointId !== assignment.leg.fromTransitPointId || !trip.atStop) throw new BadRequestException(`Collect this parcel when your vehicle is at ${await this.ctx.pointName(assignment.leg.fromTransitPointId)}`);
    const driver = await this.prisma.user.findUniqueOrThrow({ where: { id: driverId } });
    const station = await this.ctx.pointName(assignment.leg.fromTransitPointId);
    const collected = await this.prisma.$transaction(async (tx) => {
      await this.ctx.lock(tx, 'parcel_legs', assignment.leg!.id);
      await this.ctx.lock(tx, 'users', driverId);
      const fresh = await tx.parcelAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
      if (fresh.status !== AssignmentStatus.ACCEPTED) return null;
      const freshTrip = await tx.trip.findUniqueOrThrow({ where: { id: trip.id } });
      if (freshTrip.currentTransitPointId !== assignment.leg!.fromTransitPointId || !freshTrip.atStop || !OPEN.includes(freshTrip.status)) throw new ConflictException('Your trip has moved on from the pickup station');
      const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: assignment.parcelId } });
      if (parcel.custody !== CustodyHolder.STATION || parcel.currentTransitPointId !== assignment.leg!.fromTransitPointId) throw new ConflictException('The parcel is not in custody at this station');
      const load = (await this.dispatch.loads(tx, [driverId])).get(driverId) ?? { reservedKg: 0, loadedKg: 0 };
      if (load.reservedKg + load.loadedKg > vehicleCapacityKg(driver) + 1e-9) throw new ConflictException('Collecting this parcel would exceed your vehicle capacity');
      const now = new Date();
      await tx.parcelAssignment.update({ where: { id: assignmentId }, data: { status: AssignmentStatus.COLLECTED, collectedAt: now } });
      await tx.parcelLeg.update({ where: { id: assignment.leg!.id }, data: { status: ParcelLegStatus.IN_TRANSIT, collectedAt: now } });
      const status = freshTrip.status === TripStatus.IN_TRANSIT ? ParcelStatus.in_transit : ParcelStatus.collected;
      await tx.parcel.update({ where: { id: parcel.id }, data: { status, custody: CustodyHolder.DRIVER, currentTransitPointId: null, currentLocation: station, driverId, routeId: assignment.leg!.routeId, actualPickupTime: parcel.actualPickupTime ?? now } });
      await this.ctx.history(tx, { parcelId: parcel.id, status, location: station, updatedBy: driverId, notes: `${assignment.leg!.sequence > 1 ? 'Connecting driver' : 'Driver'} ${driver.name} collected the parcel at ${station} (trip ${trip.tripNumber}).` });
      await this.ctx.audit(tx, { userId: driverId, action: 'PARCEL_COLLECTED', entityType: 'ParcelAssignment', entityId: assignmentId, after: { tripId: trip.id, legId: assignment.leg!.id } });
      return parcel;
    }, TX_OPTIONS);
    if (!collected) {
      const current = await this.prisma.parcelAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
      if (current.status === AssignmentStatus.COLLECTED) return this.workspace(driverId);
      throw new ConflictException(`This assignment is ${current.status.toLowerCase()}; the parcel cannot be collected`);
    }
    await this.ctx.notifyParties(collected, { title: assignment.leg.sequence > 1 ? 'Connecting driver collected' : 'Driver collected your parcel', message: `${collected.trackingNumber} was collected at ${station} by the driver.`, type: NotificationType.PARCEL_PICKED_UP });
    this.ctx.emit('assignmentUpdate', { assignmentId, parcelId: collected.id, legId: assignment.leg.id, status: AssignmentStatus.COLLECTED, driverId }, { userIds: [driverId, collected.senderId, collected.recipientId], transitPointIds: [assignment.leg.fromTransitPointId] });
    return this.workspace(driverId);
  }

  /**
   * DROP: the driver hands parcels to the station they are standing at. Custody becomes HANDOVER until
   * the station verifies. Without ids, every parcel due at this station is dropped.
   */
  async drop(tripId: string, driverId: string, assignmentIds?: string[]) {
    const trip = await this.ownTrip(tripId, driverId);
    if (!OPEN.includes(trip.status) || !trip.atStop || !trip.currentTransitPointId) throw new BadRequestException('Drop parcels while your vehicle is standing at the station');
    const stationId = trip.currentTransitPointId;
    const due = await this.prisma.parcelAssignment.findMany({ where: { tripId, status: AssignmentStatus.COLLECTED, leg: { toTransitPointId: stationId } }, include: { leg: true } });
    const selected = assignmentIds?.length ? due.filter((item) => assignmentIds.includes(item.id)) : due;
    if (assignmentIds?.length && selected.length !== new Set(assignmentIds).size) {
      const already = await this.prisma.parcelAssignment.count({ where: { id: { in: assignmentIds }, tripId, status: { in: [AssignmentStatus.DROPPED, AssignmentStatus.COMPLETED] } } });
      if (already + selected.length !== new Set(assignmentIds).size) throw new BadRequestException('Some selected parcels are not due to be dropped at this station');
    }
    const station = await this.ctx.pointName(stationId);
    const dropped: string[] = [];
    for (const assignment of selected) {
      const ok = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const moved = await tx.parcelAssignment.updateMany({ where: { id: assignment.id, status: AssignmentStatus.COLLECTED }, data: { status: AssignmentStatus.DROPPED, droppedAt: now, dropTransitPointId: stationId } });
        if (!moved.count) return false;
        await tx.parcelLeg.update({ where: { id: assignment.leg!.id }, data: { status: ParcelLegStatus.AWAITING_VERIFICATION, droppedAt: now } });
        await tx.parcel.update({ where: { id: assignment.parcelId }, data: { status: ParcelStatus.arrived_at_transit_point, custody: CustodyHolder.HANDOVER, currentTransitPointId: stationId, currentLocation: station } });
        await this.ctx.history(tx, { parcelId: assignment.parcelId, status: ParcelStatus.arrived_at_transit_point, location: station, updatedBy: driverId, notes: `Handed over at ${station} by the driver (trip ${trip.tripNumber}); awaiting station verification.` });
        return true;
      }, TX_OPTIONS);
      if (ok) dropped.push(assignment.parcelId);
    }
    if (dropped.length) {
      const driver = await this.prisma.user.findUnique({ where: { id: driverId }, select: { name: true } });
      await this.ctx.notifyStation([stationId], { title: 'Parcels to verify', message: `${driver?.name} handed over ${dropped.length} parcel(s) at ${station} (trip ${trip.tripNumber}). Verify them.`, type: NotificationType.OFFICER_ACTION_REQUIRED, actionUrl: '/transit-officer/dashboard' });
      const parcels = await this.prisma.parcel.findMany({ where: { id: { in: dropped } }, select: { senderId: true, recipientId: true } });
      this.ctx.emit('stationWorkUpdate', { kind: 'AWAITING_VERIFICATION', tripId, transitPointId: stationId, parcelIds: dropped }, { userIds: [driverId, ...parcels.flatMap((parcel) => [parcel.senderId, parcel.recipientId])], transitPointIds: [stationId] });
      // Capacity was released: waiting parcels may now fit.
      await this.dispatch.retryWaitingLegs();
    }
    return this.workspace(driverId);
  }

  /** Hands collected parcels back to the station they were collected at (before leaving it). */
  async returnToStation(tripId: string, driverId: string, assignmentIds?: string[]) {
    const trip = await this.ownTrip(tripId, driverId);
    if (!OPEN.includes(trip.status) || !trip.atStop || !trip.currentTransitPointId) throw new BadRequestException('Return parcels while your vehicle is standing at the station');
    const stationId = trip.currentTransitPointId;
    const collected = await this.prisma.parcelAssignment.findMany({ where: { tripId, status: AssignmentStatus.COLLECTED, leg: { fromTransitPointId: stationId }, ...(assignmentIds?.length ? { id: { in: assignmentIds } } : {}) } });
    const station = await this.ctx.pointName(stationId);
    for (const assignment of collected) {
      await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const moved = await tx.parcelAssignment.updateMany({ where: { id: assignment.id, status: AssignmentStatus.COLLECTED }, data: { status: AssignmentStatus.DROPPED, droppedAt: now, dropTransitPointId: stationId } });
        if (!moved.count) return;
        await tx.parcel.update({ where: { id: assignment.parcelId }, data: { status: ParcelStatus.arrived_at_transit_point, custody: CustodyHolder.HANDOVER, currentTransitPointId: stationId, currentLocation: station } });
        await this.ctx.history(tx, { parcelId: assignment.parcelId, status: ParcelStatus.arrived_at_transit_point, location: station, updatedBy: driverId, notes: `Returned to ${station} by the driver before departure; awaiting station verification.` });
      }, TX_OPTIONS);
    }
    if (collected.length) {
      await this.ctx.notifyStation([stationId], { title: 'Parcels returned', message: `${collected.length} parcel(s) were handed back at ${station} (trip ${trip.tripNumber}). Verify them to reassign.`, type: NotificationType.OFFICER_ACTION_REQUIRED, actionUrl: '/transit-officer/dashboard' });
      this.ctx.emit('stationWorkUpdate', { kind: 'AWAITING_VERIFICATION', tripId, transitPointId: stationId }, { transitPointIds: [stationId], userIds: [driverId] });
      await this.dispatch.retryWaitingLegs();
    }
    return this.workspace(driverId);
  }

  /** COMPLETE TRIP: only at the route endpoint. Parcels due there are dropped as part of completing. */
  async complete(tripId: string, driverId: string) {
    const trip = await this.ownTrip(tripId, driverId);
    if (trip.status === TripStatus.CLOSED) return this.workspace(driverId);
    if (trip.status !== TripStatus.IN_TRANSIT) throw new ConflictException('Only a trip in progress can be completed');
    if (trip.currentTransitPointId !== trip.endTransitPointId || !trip.atStop) throw new BadRequestException(`Complete the trip at the route endpoint, ${await this.ctx.pointName(trip.endTransitPointId)}`);
    const elsewhere = await this.prisma.parcelAssignment.count({ where: { tripId, status: AssignmentStatus.COLLECTED, leg: { toTransitPointId: { not: trip.endTransitPointId! } } } });
    if (elsewhere) throw new ConflictException('Some parcels on board are due at other stations; contact the station to resolve them');
    await this.drop(tripId, driverId);
    const pending = await this.prisma.$transaction(async (tx) => {
      const closed = await tx.trip.updateMany({ where: { id: tripId, status: TripStatus.IN_TRANSIT }, data: { status: TripStatus.CLOSED, completedAt: new Date(), closedAt: new Date() } });
      if (!closed.count) return null;
      await tx.tripEvent.create({ data: { tripId, transitPointId: trip.endTransitPointId, type: 'COMPLETED', notes: `Trip completed at ${await this.ctx.pointName(trip.endTransitPointId, tx)}`, createdBy: driverId } });
      await tx.driverProfile.updateMany({ where: { userId: driverId, currentRouteId: trip.routeId }, data: { currentRouteId: null } });
      await this.ctx.audit(tx, { userId: driverId, action: 'TRIP_COMPLETED', entityType: 'Trip', entityId: tripId });
      return tx.parcelAssignment.findMany({ where: { tripId, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] } }, select: { id: true } });
    }, TX_OPTIONS);
    if (pending) await this.dispatch.cancelBySystem(pending.map((item) => item.id), 'TRIP_COMPLETED');
    this.ctx.emit('tripUpdate', { tripId, status: TripStatus.CLOSED, driverId }, { userIds: [driverId], transitPointIds: [trip.endTransitPointId] });
    return this.workspace(driverId);
  }

  /** Cancels a trip that has not started. Collected parcels must be handed back first. */
  async cancel(tripId: string, actor: Actor, reason: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip || (actor.role === UserRole.DRIVER && trip.driverId !== actor.id)) throw new NotFoundException('Trip not found');
    if (actor.role !== UserRole.DRIVER && actor.role !== UserRole.ADMIN) throw new NotFoundException('Trip not found');
    if (trip.status === TripStatus.CANCELLED) return { cancelled: true };
    if (trip.status !== TripStatus.CREATED) throw new ConflictException('A trip that has started cannot be cancelled; an admin can raise a custody exception instead');
    const onboard = await this.prisma.parcelAssignment.count({ where: { tripId, status: AssignmentStatus.COLLECTED } });
    if (onboard) throw new ConflictException(`Return the ${onboard} collected parcel(s) to the station before cancelling`);
    const pending = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.trip.updateMany({ where: { id: tripId, status: TripStatus.CREATED }, data: { status: TripStatus.CANCELLED, cancelledAt: new Date(), cancellationReason: reason?.trim() || 'Cancelled before departure' } });
      if (!updated.count) return null;
      await tx.tripEvent.create({ data: { tripId, transitPointId: trip.currentTransitPointId, type: 'CANCELLED', notes: reason?.trim() || 'Cancelled before departure', createdBy: actor.id } });
      if (trip.driverId) await tx.driverProfile.updateMany({ where: { userId: trip.driverId, currentRouteId: trip.routeId }, data: { currentRouteId: null } });
      await this.ctx.audit(tx, { userId: actor.id, action: 'TRIP_CANCELLED', entityType: 'Trip', entityId: tripId, after: { reason } });
      return tx.parcelAssignment.findMany({ where: { tripId, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] } }, select: { id: true } });
    }, TX_OPTIONS);
    if (pending) await this.dispatch.cancelBySystem(pending.map((item) => item.id), 'TRIP_CANCELLED');
    this.ctx.emit('tripUpdate', { tripId, status: TripStatus.CANCELLED, driverId: trip.driverId }, { userIds: [trip.driverId] });
    return { cancelled: true };
  }

  /**
   * Admin: the driver can no longer complete a started trip. Uncollected offers are reassigned; parcels
   * already on board stay in that driver's custody until a station receives them (never auto-reassigned).
   */
  async custodyException(tripId: string, actor: Actor, reason: string) {
    if (actor.role !== UserRole.ADMIN) throw new NotFoundException('Trip not found');
    const text = reason?.trim();
    if (!text || text.length < 5) throw new BadRequestException('A reason of at least 5 characters is required');
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip || !OPEN.includes(trip.status)) throw new NotFoundException('Open trip not found');
    const driver = trip.driverId ? await this.prisma.user.findUnique({ where: { id: trip.driverId }, select: { name: true, phone: true } }) : null;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.trip.update({ where: { id: tripId }, data: { status: TripStatus.CANCELLED, cancelledAt: new Date(), cancellationReason: `Custody exception: ${text}` } });
      await tx.tripEvent.create({ data: { tripId, transitPointId: trip.currentTransitPointId, type: 'CANCELLED', notes: `Custody exception: ${text}`, createdBy: actor.id } });
      if (trip.driverId) await tx.driverProfile.updateMany({ where: { userId: trip.driverId, currentRouteId: trip.routeId }, data: { currentRouteId: null } });
      const onboard = await tx.parcelAssignment.findMany({ where: { tripId, status: AssignmentStatus.COLLECTED }, include: { leg: true } });
      const alerts: { alert: { id: string; parcelId: string; type: TamperAlertType; details: string; transitPointId: string | null }; trackingNumber: string }[] = [];
      for (const assignment of onboard) {
        const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: assignment.parcelId } });
        await this.ctx.history(tx, { parcelId: parcel.id, status: parcel.status, location: parcel.currentLocation, updatedBy: actor.id, notes: `Trip ${trip.tripNumber} stopped (${text}). The parcel stays with driver ${driver?.name ?? ''} until a station receives it.` });
        const { alert } = await this.ctx.raiseAlert(tx, { parcelId: parcel.id, type: TamperAlertType.CUSTODY_EXCEPTION, transitPointId: assignment.leg?.toTransitPointId, legId: assignment.legId, tripId, assignmentId: assignment.id, details: `Driver ${driver?.name ?? ''} (${driver?.phone ?? 'no phone'}) cannot finish trip ${trip.tripNumber}: ${text}. Receive the parcel at the nearest station.` });
        alerts.push({ alert, trackingNumber: parcel.trackingNumber });
      }
      await this.ctx.audit(tx, { userId: actor.id, action: 'TRIP_CUSTODY_EXCEPTION', entityType: 'Trip', entityId: tripId, after: { reason: text, onboard: onboard.map((item) => item.parcelId) } });
      const pending = await tx.parcelAssignment.findMany({ where: { tripId, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] } }, select: { id: true } });
      return { alerts, pending };
    }, TX_OPTIONS);
    await this.dispatch.cancelBySystem(result.pending.map((item) => item.id), 'TRIP_CANCELLED');
    for (const { alert, trackingNumber } of result.alerts) await this.ctx.announceAlert(alert, trackingNumber);
    this.ctx.emit('tripUpdate', { tripId, status: TripStatus.CANCELLED, driverId: trip.driverId }, { userIds: [trip.driverId] });
    return { cancelled: true, parcelsInDriverCustody: result.alerts.length };
  }

  /**
   * Everything the driver screen needs: capacity, open trip with every route stop and the activity
   * derived at each, offers with their deadlines, accepted and on-board parcels.
   */
  async workspace(driverId: string) {
    const driver = await this.prisma.user.findUnique({ where: { id: driverId }, include: { driverProfile: true } });
    if (!driver) throw new NotFoundException('Driver not found');
    const network = await this.ctx.network();
    const load = (await this.dispatch.loads(this.prisma, [driverId])).get(driverId) ?? { reservedKg: 0, loadedKg: 0 };
    const capacityKg = vehicleCapacityKg(driver);
    const routes = (driver.driverProfile?.routesServed ?? []).filter((routeId) => network.isRouteUsable(routeId)).map((routeId) => {
      const stops = network.stops(routeId);
      return { id: routeId, name: network.route(routeId)?.name, endpoints: [stops[0], stops[stops.length - 1]].map((stop) => ({ id: stop.transitPointId, name: stop.name })), stops: stops.map((stop) => ({ id: stop.transitPointId, name: stop.name })) };
    });
    const trip = await this.prisma.trip.findFirst({ where: { driverId, status: { in: OPEN } }, orderBy: { createdAt: 'desc' } });
    const assignments = await this.prisma.parcelAssignment.findMany({
      where: trip ? { OR: [{ tripId: trip.id }, { driverId, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED, AssignmentStatus.COLLECTED] } }] } : { driverId, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED, AssignmentStatus.COLLECTED] } },
      include: { leg: true },
      orderBy: { assignedAt: 'asc' },
    });
    const parcels = assignments.length ? await this.prisma.parcel.findMany({ where: { id: { in: [...new Set(assignments.map((item) => item.parcelId))] } }, select: { id: true, trackingNumber: true, weight: true, recipientName: true, description: true, status: true, deliveryInstructions: true, isFragile: true } }) : [];
    const inspections = assignments.length ? await this.prisma.transitInspection.findMany({ where: { assignmentId: { in: assignments.map((item) => item.id) } } }) : [];
    const card = (assignment: typeof assignments[number]) => {
      const parcel = parcels.find((item) => item.id === assignment.parcelId);
      const inspection = inspections.find((item) => item.assignmentId === assignment.id);
      return {
        assignmentId: assignment.id, parcelId: assignment.parcelId, trackingNumber: parcel?.trackingNumber, weightKg: parcel?.weight, recipientName: parcel?.recipientName,
        description: parcel?.description, fragile: parcel?.isFragile, instructions: parcel?.deliveryInstructions, status: assignment.status,
        from: network.point(assignment.leg?.fromTransitPointId ?? '')?.name, fromTransitPointId: assignment.leg?.fromTransitPointId,
        to: network.point(assignment.leg?.toTransitPointId ?? '')?.name, toTransitPointId: assignment.leg?.toTransitPointId,
        assignedAt: assignment.assignedAt, acceptanceDeadline: assignment.acceptanceDeadline, acceptedAt: assignment.acceptedAt, collectedAt: assignment.collectedAt, droppedAt: assignment.droppedAt,
        verification: inspection?.decision ?? null,
      };
    };
    const active = assignments.filter((item) => [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED, AssignmentStatus.COLLECTED].includes(item.status as any));
    let tripView: any = null;
    if (trip) {
      const { stops, current } = this.position(network, trip);
      const onTrip = assignments.filter((item) => item.tripId === trip.id && ![AssignmentStatus.REJECTED, AssignmentStatus.EXPIRED, AssignmentStatus.CANCELLED].includes(item.status as any));
      const stopViews = stops.map((stop) => {
        // Parcels handed back at their own pickup station are no longer pickups of this trip.
        const pickups = onTrip.filter((item) => item.leg?.fromTransitPointId === stop.transitPointId && item.dropTransitPointId !== stop.transitPointId).map(card);
        const drops = onTrip.filter((item) => item.leg?.toTransitPointId === stop.transitPointId && [AssignmentStatus.COLLECTED, AssignmentStatus.DROPPED, AssignmentStatus.COMPLETED].includes(item.status as any)).map(card);
        const isStart = stop.index === 0;
        const isEnd = stop.index === stops.length - 1;
        const state = trip.status === TripStatus.CREATED ? (stop.index === 0 ? 'CURRENT' : 'UPCOMING')
          : stop.index < current || (stop.index === current && !trip.atStop) ? 'PASSED' : stop.index === current ? 'CURRENT' : 'UPCOMING';
        const operations = [...(pickups.length ? ['PICKUP'] : []), ...(drops.length ? ['DROPOFF'] : []), ...(isEnd ? ['ROUTE_ENDPOINT'] : [])];
        const exceptions = drops.filter((item) => item.verification && item.verification !== 'VERIFIED').length;
        return {
          transitPointId: stop.transitPointId, name: stop.name, index: stop.index, state, isStart, isEnd,
          active: pickups.length > 0 || drops.length > 0 || isEnd,
          operations: operations.length === 2 && !isEnd ? ['PICKUP_AND_DROPOFF'] : operations,
          pickups, drops, pickupCount: pickups.length, dropoffCount: drops.length,
          pickupsCollected: pickups.filter((item) => item.status === AssignmentStatus.COLLECTED || item.status === AssignmentStatus.DROPPED || item.status === AssignmentStatus.COMPLETED).length,
          dropsHandedOver: drops.filter((item) => item.status !== AssignmentStatus.COLLECTED).length,
          dropsVerified: drops.filter((item) => item.verification === 'VERIFIED').length,
          exceptions,
          cumulativeKm: Math.round(stop.cumulativeKm * 10) / 10,
        };
      });
      const currentStop = stopViews[current];
      const undroppedHere = currentStop?.drops.filter((item) => item.status === AssignmentStatus.COLLECTED).length ?? 0;
      tripView = {
        id: trip.id, tripNumber: trip.tripNumber, status: trip.status, routeId: trip.routeId, route: network.route(trip.routeId)?.name, direction: trip.direction,
        start: network.point(trip.startTransitPointId ?? '')?.name, end: network.point(trip.endTransitPointId ?? '')?.name,
        currentTransitPointId: trip.currentTransitPointId, current: currentStop?.name, atStop: trip.atStop, startedAt: trip.startedAt, createdAt: trip.createdAt,
        nextStop: stopViews.slice(current + (trip.atStop && trip.status === TripStatus.IN_TRANSIT ? 1 : trip.status === TripStatus.CREATED ? 1 : 0)).find((stop) => stop.state === 'UPCOMING') ?? null,
        nextActiveStop: stopViews.find((stop) => stop.state === 'UPCOMING' && stop.active) ?? null,
        canStart: trip.status === TripStatus.CREATED,
        canDepart: trip.status === TripStatus.IN_TRANSIT && trip.atStop && !currentStop?.isEnd && undroppedHere === 0,
        canComplete: trip.status === TripStatus.IN_TRANSIT && trip.atStop && !!currentStop?.isEnd,
        stops: stopViews,
      };
    }
    const recentTrips = await this.prisma.trip.findMany({ where: { driverId, status: { in: [TripStatus.CLOSED, TripStatus.CANCELLED] } }, orderBy: { createdAt: 'desc' }, take: 5 });
    return {
      driver: {
        id: driver.id, name: driver.name, vehicleType: driver.vehicleType, vehicleNumber: driver.vehicleNumber, onDuty: driver.isAvailable,
        approved: ['APPROVED', 'ACTIVE'].includes(driver.driverProfile?.approvalStatus ?? ''),
      },
      capacity: { capacityKg, loadedKg: round(load.loadedKg), reservedKg: round(load.reservedKg), availableKg: round(Math.max(0, capacityKg - load.loadedKg - load.reservedKg)) },
      routes,
      trip: tripView,
      offers: active.filter((item) => item.status === AssignmentStatus.ASSIGNED).map(card),
      accepted: active.filter((item) => item.status === AssignmentStatus.ACCEPTED).map(card),
      onboard: active.filter((item) => item.status === AssignmentStatus.COLLECTED).map(card),
      recentTrips: recentTrips.map((item) => ({ id: item.id, tripNumber: item.tripNumber, route: network.route(item.routeId)?.name, status: item.status, startedAt: item.startedAt, completedAt: item.completedAt, cancelledAt: item.cancelledAt })),
    };
  }

  /** Staff view of trips (admin: all; officer: trips on routes through their stations). */
  async listTrips(actor: Actor, filter: { status?: string } = {}) {
    const network = await this.ctx.network();
    const pointIds = actor.role === UserRole.TRANSIT_OFFICER ? await this.ctx.assignedPointIds(actor.id) : null;
    const routeIds = pointIds ? network.routes().filter((route) => network.stops(route.id).some((stop) => pointIds.includes(stop.transitPointId))).map((route) => route.id) : null;
    const trips = await this.prisma.trip.findMany({
      where: { ...(routeIds ? { routeId: { in: routeIds } } : {}), ...(filter.status ? { status: filter.status as TripStatus } : {}), startTransitPointId: { not: null } },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
    const drivers = await this.prisma.user.findMany({ where: { id: { in: trips.map((trip) => trip.driverId).filter((id): id is string => !!id) } }, select: { id: true, name: true, phone: true, vehicleNumber: true, vehicleType: true, maxLoadKg: true } });
    const counts = await this.prisma.parcelAssignment.groupBy({ by: ['tripId', 'status'], where: { tripId: { in: trips.map((trip) => trip.id) } }, _count: true });
    return trips.map((trip) => ({
      id: trip.id, tripNumber: trip.tripNumber, status: trip.status, route: network.route(trip.routeId)?.name, routeId: trip.routeId, direction: trip.direction,
      start: network.point(trip.startTransitPointId ?? '')?.name, end: network.point(trip.endTransitPointId ?? '')?.name,
      current: network.point(trip.currentTransitPointId ?? '')?.name, atStop: trip.atStop, createdAt: trip.createdAt, startedAt: trip.startedAt, completedAt: trip.completedAt, cancelledAt: trip.cancelledAt, cancellationReason: trip.cancellationReason,
      driver: drivers.find((driver) => driver.id === trip.driverId) ?? null,
      parcels: Object.fromEntries(counts.filter((item) => item.tripId === trip.id).map((item) => [item.status, item._count])),
    }));
  }

  async tripDetail(tripId: string, actor: Actor) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');
    if (actor.role === UserRole.DRIVER) {
      if (trip.driverId !== actor.id) throw new NotFoundException('Trip not found');
      return this.workspace(actor.id);
    }
    const events = await this.prisma.tripEvent.findMany({ where: { tripId }, orderBy: { createdAt: 'asc' } });
    const [summary] = (await this.listTrips({ id: actor.id, role: UserRole.ADMIN })).filter((item) => item.id === tripId);
    return { ...(summary ?? { id: trip.id }), events, workspace: trip.driverId ? (await this.workspace(trip.driverId)) : null };
  }
}

const round = (value: number) => Math.round(value * 10) / 10;
