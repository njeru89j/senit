import { Injectable } from '@nestjs/common';
import { AlertStatus, AssignmentStatus, Parcel, ParcelLegStatus, ParcelStatus, TripStatus } from '@prisma/client';
import { NO_DRIVER_MESSAGES, NoDriverReason, vehicleCapacityKg } from './dispatch-rules';
import { DispatchService } from './dispatch.service';
import { JourneyService } from './journey.service';
import { Actor, OPEN_TRIP_STATUSES, WorkflowContext } from './workflow-context.service';

/** The transit officer's work queues for their station(s), all derived from journey, assignment and trip records. */
@Injectable()
export class StationQueuesService {
  constructor(private readonly ctx: WorkflowContext, private readonly dispatch: DispatchService, private readonly journey: JourneyService) {}

  private get prisma() { return this.ctx.prisma; }

  async queues(actor: Actor, transitPointId?: string) {
    const pointIds = await this.ctx.stationScope(actor, transitPointId);
    const network = await this.ctx.network();
    const name = (id?: string | null) => (id ? network.point(id)?.name ?? 'Station' : null);
    const now = new Date();
    const summary = (parcel: Parcel) => ({
      id: parcel.id, trackingNumber: parcel.trackingNumber, weight: parcel.weight, senderName: parcel.senderName, recipientName: parcel.recipientName,
      recipientPhone: parcel.recipientPhone, origin: name(parcel.originTransitPointId) ?? parcel.pickupAddress, destination: name(parcel.destinationTransitPointId) ?? parcel.deliveryAddress,
      destinationTransitPointId: parcel.destinationTransitPointId,
      status: parcel.status, statusLabel: this.journey.statusLabel(parcel), custody: parcel.custody, station: name(parcel.currentTransitPointId), currentTransitPointId: parcel.currentTransitPointId,
      deliveryMethod: parcel.deliveryMethod, readyForCollectionAt: parcel.readyForCollectionAt, collectionDeadlineAt: parcel.collectionDeadlineAt, createdAt: parcel.createdAt, qrSealIdentifier: parcel.qrSealIdentifier,
    });
    if (!pointIds.length) return { stations: [], queues: null, counts: {} };

    const [awaitingConfirmation, legs, recentFailures, collected, dropped, stationParcels, alerts, openTrips] = await Promise.all([
      this.prisma.parcel.findMany({ where: { deletedAt: null, status: ParcelStatus.awaiting_confirmation, OR: [{ originTransitPointId: { in: pointIds } }, { originTransitPointId: null, currentTransitPointId: { in: pointIds } }] }, orderBy: { createdAt: 'asc' } }),
      this.prisma.parcelLeg.findMany({ where: { status: { in: [ParcelLegStatus.AWAITING_DRIVER, ParcelLegStatus.DRIVER_ASSIGNED, ParcelLegStatus.EXCEPTION] }, OR: [{ fromTransitPointId: { in: pointIds } }, { toTransitPointId: { in: pointIds }, status: ParcelLegStatus.EXCEPTION }] }, include: { parcel: true, assignments: { where: { status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] } } } }, orderBy: { activatedAt: 'asc' } }),
      this.prisma.parcelAssignment.findMany({ where: { status: { in: [AssignmentStatus.REJECTED, AssignmentStatus.EXPIRED, AssignmentStatus.CANCELLED] }, assignedAt: { gt: new Date(now.getTime() - 24 * 3600_000) }, leg: { fromTransitPointId: { in: pointIds } } }, include: { leg: true }, orderBy: { assignedAt: 'desc' }, take: 50 }),
      this.prisma.parcelAssignment.findMany({ where: { status: AssignmentStatus.COLLECTED, leg: { toTransitPointId: { in: pointIds } } }, include: { leg: true, trip: true } }),
      this.prisma.parcelAssignment.findMany({ where: { status: AssignmentStatus.DROPPED, dropTransitPointId: { in: pointIds } }, include: { leg: true, trip: true } }),
      this.prisma.parcel.findMany({ where: { deletedAt: null, currentTransitPointId: { in: pointIds }, status: { in: [ParcelStatus.at_transit_point, ParcelStatus.at_destination, ParcelStatus.locker_assigned, ParcelStatus.in_locker] } }, orderBy: { updatedAt: 'asc' } }),
      this.prisma.tamperAlert.findMany({ where: { status: { not: AlertStatus.RESOLVED }, OR: [{ transitPointId: { in: pointIds } }, ...(actor.role === 'ADMIN' && !transitPointId ? [{ transitPointId: null }] : [])] }, orderBy: { createdAt: 'desc' } }),
      this.prisma.trip.findMany({ where: { status: { in: [...OPEN_TRIP_STATUSES] } } }),
    ]);

    const parcelIds = [...new Set([...collected, ...dropped, ...recentFailures].map((item) => item.parcelId).concat(alerts.map((alert) => alert.parcelId)))];
    const extraParcels = parcelIds.length ? await this.prisma.parcel.findMany({ where: { id: { in: parcelIds } } }) : [];
    const driverIds = [...new Set([...legs.flatMap((leg) => leg.assignments.map((item) => item.driverId)), ...collected.map((item) => item.driverId), ...dropped.map((item) => item.driverId), ...recentFailures.map((item) => item.driverId), ...openTrips.map((trip) => trip.driverId!).filter(Boolean)])];
    const drivers = driverIds.length ? await this.prisma.user.findMany({ where: { id: { in: driverIds } }, select: { id: true, name: true, phone: true, vehicleNumber: true, vehicleType: true, maxLoadKg: true, currentLat: true, currentLng: true, lastActiveAt: true } }) : [];
    const driver = (id: string) => drivers.find((item) => item.id === id) ?? null;
    const parcelOf = (id: string) => extraParcels.find((item) => item.id === id) ?? legs.find((leg) => leg.parcelId === id)?.parcel;
    const verifiedIds = new Set((dropped.length ? await this.prisma.transitInspection.findMany({ where: { assignmentId: { in: dropped.map((item) => item.id) } }, select: { assignmentId: true } }) : []).map((item) => item.assignmentId));

    const tripSummary = (trip: { id: string; tripNumber: string; routeId: string; direction: 'FORWARD' | 'REVERSE'; status: TripStatus; currentTransitPointId: string | null; atStop: boolean; driverId: string | null; startTransitPointId: string | null; endTransitPointId: string | null }) => {
      const stops = network.stops(trip.routeId, trip.direction);
      return {
        id: trip.id, tripNumber: trip.tripNumber, route: network.route(trip.routeId)?.name, status: trip.status, direction: trip.direction,
        start: name(trip.startTransitPointId), end: name(trip.endTransitPointId), current: name(trip.currentTransitPointId), atStop: trip.atStop,
        currentIndex: stops.findIndex((stop) => stop.transitPointId === trip.currentTransitPointId), driver: trip.driverId ? driver(trip.driverId) : null,
      };
    };

    // Handovers to verify: dropped here (not yet inspected), or still on a trip standing here / stopped by an exception.
    const verifyGroups = new Map<string, { trip: ReturnType<typeof tripSummary> | null; transitPointId: string; station: string | null; parcels: any[] }>();
    const addVerify = (assignment: (typeof dropped)[number], stationId: string, implicit: boolean) => {
      const key = `${assignment.tripId}|${stationId}`;
      const group = verifyGroups.get(key) ?? { trip: assignment.trip ? tripSummary(assignment.trip) : null, transitPointId: stationId, station: name(stationId), parcels: [] };
      const parcel = parcelOf(assignment.parcelId);
      group.parcels.push({ ...(parcel ? summary(parcel) : { id: assignment.parcelId }), assignmentId: assignment.id, droppedAt: assignment.droppedAt, implicitDrop: implicit, driver: driver(assignment.driverId), returned: assignment.leg?.fromTransitPointId === stationId });
      verifyGroups.set(key, group);
    };
    for (const assignment of dropped) if (!verifiedIds.has(assignment.id)) addVerify(assignment, assignment.dropTransitPointId!, false);
    for (const assignment of collected) {
      const trip = assignment.trip;
      if (!trip || !assignment.leg) continue;
      if (trip.status === TripStatus.CANCELLED || (trip.currentTransitPointId === assignment.leg.toTransitPointId && trip.atStop && pointIds.includes(trip.currentTransitPointId!))) addVerify(assignment, trip.status === TripStatus.CANCELLED ? assignment.leg.toTransitPointId : trip.currentTransitPointId!, true);
    }

    // Incoming: parcels on moving trips whose drop-off is one of our stations.
    const incomingGroups = new Map<string, { trip: ReturnType<typeof tripSummary>; transitPointId: string; station: string | null; parcels: any[]; stopsAway: number | null }>();
    for (const assignment of collected) {
      const trip = assignment.trip;
      if (!trip || !assignment.leg || trip.status === TripStatus.CANCELLED) continue;
      if (trip.currentTransitPointId === assignment.leg.toTransitPointId && trip.atStop) continue;
      const stops = network.stops(trip.routeId, trip.direction).map((stop) => stop.transitPointId);
      const key = `${trip.id}|${assignment.leg.toTransitPointId}`;
      const group = incomingGroups.get(key) ?? { trip: tripSummary(trip), transitPointId: assignment.leg.toTransitPointId, station: name(assignment.leg.toTransitPointId), parcels: [], stopsAway: stops.indexOf(assignment.leg.toTransitPointId) - stops.indexOf(trip.currentTransitPointId ?? '') };
      const parcel = parcelOf(assignment.parcelId);
      group.parcels.push({ ...(parcel ? summary(parcel) : { id: assignment.parcelId }), assignmentId: assignment.id });
      incomingGroups.set(key, group);
    }

    const awaitingDriver = legs.filter((leg) => leg.status === ParcelLegStatus.AWAITING_DRIVER).map((leg) => ({
      ...summary(leg.parcel), legId: leg.id, legSequence: leg.sequence, from: name(leg.fromTransitPointId), to: name(leg.toTransitPointId), isTransfer: leg.sequence > 1,
      waitingSince: leg.activatedAt, lastAttemptAt: leg.lastAssignmentAttemptAt, noDriverReason: leg.noDriverReason,
      noDriverMessage: leg.noDriverReason ? NO_DRIVER_MESSAGES[leg.noDriverReason as NoDriverReason] ?? leg.noDriverReason : 'Looking for a driver',
    }));
    const assigned = legs.filter((leg) => leg.status === ParcelLegStatus.DRIVER_ASSIGNED).map((leg) => {
      const offer = leg.assignments[0];
      const trip = openTrips.find((item) => item.id === offer?.tripId);
      return {
        ...summary(leg.parcel), legId: leg.id, legSequence: leg.sequence, from: name(leg.fromTransitPointId), to: name(leg.toTransitPointId), isTransfer: leg.sequence > 1,
        assignment: offer ? { id: offer.id, status: offer.status, assignedAt: offer.assignedAt, acceptanceDeadline: offer.acceptanceDeadline, acceptedAt: offer.acceptedAt, automatic: offer.assignedBy === 'system', driver: driver(offer.driverId), trip: trip ? tripSummary(trip) : null } : null,
      };
    });
    // Legs blocked without an open alert (e.g. no route left); parcels with an alert are handled in the alert list.
    const legExceptions = legs.filter((leg) => leg.status === ParcelLegStatus.EXCEPTION && !alerts.some((alert) => alert.parcelId === leg.parcelId)).map((leg) => ({ ...summary(leg.parcel), legId: leg.id, from: name(leg.fromTransitPointId), to: name(leg.toTransitPointId) }));
    const failures = recentFailures.map((item) => ({ assignmentId: item.id, status: item.status, parcel: parcelOf(item.parcelId) ? summary(parcelOf(item.parcelId)!) : null, driver: driver(item.driverId), at: item.rejectedAt ?? item.expiredAt ?? item.cancelledAt, reason: item.rejectionReason ?? item.cancellationReason ?? (item.status === AssignmentStatus.EXPIRED ? 'Not accepted within 3 hours' : null) }));

    const lockerHolds = stationParcels.some((parcel) => parcel.status === ParcelStatus.locker_assigned || parcel.status === ParcelStatus.in_locker)
      ? await this.prisma.lockerAssignment.findMany({ where: { parcelId: { in: stationParcels.map((parcel) => parcel.id) }, collectedAt: null, cancelledAt: null } })
      : [];
    const compartments = lockerHolds.length ? await this.prisma.lockerCompartment.findMany({ where: { id: { in: lockerHolds.map((hold) => hold.compartmentId) } } }) : [];
    const withLocker = (parcel: Parcel) => {
      const hold = lockerHolds.find((item) => item.parcelId === parcel.id);
      return { ...summary(parcel), locker: hold ? { lockerAssignmentId: hold.id, compartmentNo: compartments.find((item) => item.id === hold.compartmentId)?.compartmentNo, placedAt: hold.placedAt, assignedAt: hold.assignedAt } : null };
    };
    const nextLegs = await this.prisma.parcelLeg.findMany({ where: { parcelId: { in: stationParcels.filter((parcel) => parcel.status === ParcelStatus.at_transit_point).map((parcel) => parcel.id) }, status: { in: [ParcelLegStatus.AWAITING_DRIVER, ParcelLegStatus.DRIVER_ASSIGNED, ParcelLegStatus.EXCEPTION] } } });
    const transfers = stationParcels.filter((parcel) => parcel.status === ParcelStatus.at_transit_point).map((parcel) => {
      const leg = nextLegs.find((item) => item.parcelId === parcel.id);
      return { ...summary(parcel), nextLeg: leg ? { id: leg.id, to: name(leg.toTransitPointId), status: leg.status, route: network.route(leg.routeId)?.name } : null };
    });
    const atDestination = stationParcels.filter((parcel) => parcel.status === ParcelStatus.at_destination);

    const exceptions = alerts.map((alert) => ({ id: alert.id, type: alert.type, status: alert.status, details: alert.details, createdAt: alert.createdAt, transitPointId: alert.transitPointId, station: name(alert.transitPointId), parcel: parcelOf(alert.parcelId) ? summary(parcelOf(alert.parcelId)!) : { id: alert.parcelId } }));

    // Drivers with open trips through our stations, with their load.
    const throughUs = openTrips.filter((trip) => network.stops(trip.routeId).some((stop) => pointIds.includes(stop.transitPointId)));
    const loads = await this.dispatch.loads(this.prisma, throughUs.map((trip) => trip.driverId!).filter(Boolean));
    const driverRows = throughUs.map((trip) => {
      const info = trip.driverId ? driver(trip.driverId) : null;
      const load = loads.get(trip.driverId ?? '') ?? { reservedKg: 0, loadedKg: 0 };
      const capacityKg = info ? vehicleCapacityKg(info) : 0;
      return { ...tripSummary(trip), capacity: { capacityKg, loadedKg: load.loadedKg, reservedKg: load.reservedKg, availableKg: Math.max(0, capacityKg - load.loadedKg - load.reservedKg) } };
    });

    const queues = {
      awaitingConfirmation: awaitingConfirmation.map(summary),
      awaitingDriver,
      assigned,
      assignmentFailures: failures,
      incoming: [...incomingGroups.values()].sort((a, b) => (a.stopsAway ?? 99) - (b.stopsAway ?? 99)),
      toVerify: [...verifyGroups.values()],
      transfers,
      readyForCollection: atDestination.filter((parcel) => !parcel.collectionDeadlineAt || parcel.collectionDeadlineAt >= now).map(withLocker),
      overdue: atDestination.filter((parcel) => parcel.collectionDeadlineAt && parcel.collectionDeadlineAt < now).map(withLocker),
      lockerPlacement: stationParcels.filter((parcel) => parcel.status === ParcelStatus.locker_assigned).map(withLocker),
      inLocker: stationParcels.filter((parcel) => parcel.status === ParcelStatus.in_locker).map(withLocker),
      exceptions,
      legExceptions,
      drivers: driverRows,
    };
    return {
      stations: pointIds.map((id) => ({ id, name: name(id) })),
      queues,
      counts: Object.fromEntries(Object.entries(queues).map(([key, value]) => [key, key === 'toVerify' || key === 'incoming' ? (value as any[]).reduce((sum, group) => sum + group.parcels.length, 0) : (value as any[]).length])),
    };
  }
}
