import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, NotificationType, ParcelAssignment, ParcelLegStatus, TripStatus, UserRole } from '@prisma/client';
import { RouteNetwork } from '../../common/route-planner';
import {
  ACCEPTANCE_WINDOW_MS, CandidateTrip, Evaluation, NO_DRIVER_MESSAGES, NoDriverReason,
  diagnoseNoDriver, evaluateTrip, rankEligible, vehicleCapacityKg,
  formatDeadline,
} from './dispatch-rules';
import { Actor, CAPACITY_STATUSES, OPEN_TRIP_STATUSES, SYSTEM_ACTOR, TX_OPTIONS, Tx, WorkflowContext } from './workflow-context.service';

export type AssignOutcome =
  | { assigned: true; assignmentId: string; driver: { id: string; name: string }; tripId: string; acceptanceDeadline: Date }
  | { assigned: false; reason: string; code?: NoDriverReason | 'NOT_WAITING' };

/** Why a driver's offer ended without collection. */
export type ReleaseReason = 'REJECTED' | 'EXPIRED' | 'OFFICER_CANCELLED' | 'PICKUP_PASSED' | 'TRIP_COMPLETED' | 'TRIP_CANCELLED' | 'JOURNEY_REPLANNED' | 'ROUTE_UNAVAILABLE' | 'PARCEL_CANCELLED' | 'WEIGHT_CORRECTED';

const RELEASE_TEXT: Record<Exclude<ReleaseReason, 'REJECTED' | 'EXPIRED'>, string> = {
  OFFICER_CANCELLED: 'cancelled by the station',
  PICKUP_PASSED: 'the trip passed the pickup station before collection',
  TRIP_COMPLETED: 'the trip was completed before collection',
  TRIP_CANCELLED: 'the trip was cancelled before collection',
  JOURNEY_REPLANNED: 'the journey was re-planned',
  ROUTE_UNAVAILABLE: 'the route became unavailable',
  PARCEL_CANCELLED: 'the parcel was cancelled',
  WEIGHT_CORRECTED: 'the parcel weight was corrected',
};

const ACTIVE_OFFER = [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED];

/**
 * Automatic driver assignment and the assignment lifecycle (offer, accept, reject, expire, cancel).
 * Every capacity-affecting write locks the parcel leg and then the driver row, re-checks the rules
 * inside the lock, and relies on the one-active-assignment-per-leg index as a final guard.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(private readonly ctx: WorkflowContext) {}

  private get prisma() { return this.ctx.prisma; }

  /** Open trips with their driver's current load, shaped for the eligibility rules. */
  async candidateTrips(db: Tx | WorkflowContext['prisma'] = this.prisma, excluded = new Set<string>()): Promise<CandidateTrip[]> {
    const trips = await db.trip.findMany({ where: { status: { in: [...OPEN_TRIP_STATUSES] }, driverId: { not: null } }, orderBy: { createdAt: 'asc' } });
    if (!trips.length) return [];
    const driverIds = [...new Set(trips.map((trip) => trip.driverId!))];
    const [drivers, loads] = await Promise.all([
      db.user.findMany({
        where: { id: { in: driverIds }, role: UserRole.DRIVER, isActive: true, isAvailable: true, deletedAt: null, driverProfile: { is: { approvalStatus: { in: ['APPROVED', 'ACTIVE'] } } } },
        include: { driverProfile: { select: { routesServed: true } } },
      }),
      this.loads(db, driverIds),
    ]);
    return trips.flatMap((trip) => {
      const driver = drivers.find((item) => item.id === trip.driverId);
      if (!driver || !driver.driverProfile?.routesServed.includes(trip.routeId)) return [];
      const load = loads.get(driver.id) ?? { reservedKg: 0, loadedKg: 0 };
      return [{
        tripId: trip.id,
        driverId: driver.id,
        driverName: driver.name,
        routeId: trip.routeId,
        direction: trip.direction,
        status: trip.status as 'CREATED' | 'IN_TRANSIT',
        currentTransitPointId: trip.currentTransitPointId ?? trip.startTransitPointId ?? '',
        atStop: trip.atStop,
        createdAt: trip.createdAt,
        vehicleType: driver.vehicleType,
        capacityKg: vehicleCapacityKg(driver),
        reservedKg: load.reservedKg,
        loadedKg: load.loadedKg,
        gps: driver.currentLat != null && driver.currentLng != null && driver.lastActiveAt ? { latitude: driver.currentLat, longitude: driver.currentLng, at: driver.lastActiveAt } : null,
        excluded: excluded.has(`${driver.id}|${trip.id}`),
      }];
    });
  }

  /** Reserved (offered/accepted) and loaded (collected) kilograms per driver. */
  async loads(db: Tx | WorkflowContext['prisma'], driverIds: string[]): Promise<Map<string, { reservedKg: number; loadedKg: number }>> {
    const rows = await db.parcelAssignment.groupBy({
      by: ['driverId', 'status'],
      where: { driverId: { in: driverIds }, status: { in: [...CAPACITY_STATUSES] } },
      _sum: { reservedWeightKg: true },
    });
    const result = new Map<string, { reservedKg: number; loadedKg: number }>();
    for (const row of rows) {
      const entry = result.get(row.driverId) ?? { reservedKg: 0, loadedKg: 0 };
      const kg = row._sum.reservedWeightKg ?? 0;
      if (row.status === AssignmentStatus.COLLECTED) entry.loadedKg += kg; else entry.reservedKg += kg;
      result.set(row.driverId, entry);
    }
    return result;
  }

  /**
   * Driver/trip pairs that must not be offered this leg again: they rejected it, let it expire, had it
   * cancelled by the station, or handed it back at its pickup station.
   */
  private async declinedPairs(legId: string, db: Tx | WorkflowContext['prisma'] = this.prisma): Promise<Set<string>> {
    const leg = await db.parcelLeg.findUnique({ where: { id: legId }, select: { fromTransitPointId: true } });
    const history = await db.parcelAssignment.findMany({
      where: {
        legId,
        OR: [
          { status: { in: [AssignmentStatus.REJECTED, AssignmentStatus.EXPIRED] } },
          // Officer cancellations count as a decline; system withdrawals (pickup passed, re-plan, weight) do not.
          { status: AssignmentStatus.CANCELLED, cancellationReason: { startsWith: RELEASE_TEXT.OFFICER_CANCELLED } },
          ...(leg ? [{ dropTransitPointId: leg.fromTransitPointId }] : []),
        ],
      },
      select: { driverId: true, tripId: true },
    });
    return new Set(history.map((item) => `${item.driverId}|${item.tripId}`));
  }

  /** Every open trip evaluated for a leg (used by the engine and by the officer's exception screen). */
  async evaluateLeg(legId: string, options: { ignoreDeclined?: boolean } = {}) {
    const leg = await this.prisma.parcelLeg.findUnique({ where: { id: legId }, include: { parcel: true } });
    if (!leg) throw new NotFoundException('Parcel leg not found');
    const network = await this.ctx.network();
    const excluded = options.ignoreDeclined ? new Set<string>() : await this.declinedPairs(legId);
    const trips = await this.candidateTrips(this.prisma, excluded);
    const request = { fromTransitPointId: leg.fromTransitPointId, toTransitPointId: leg.toTransitPointId, weightKg: leg.parcel.weight };
    const evaluations = trips.map((trip) => evaluateTrip(network, trip, request));
    return { leg, network, trips, evaluations, ranked: rankEligible(evaluations) };
  }

  private async heavierThanAllVehicles(network: RouteNetwork, fromId: string, toId: string, weightKg: number): Promise<boolean> {
    const covering = network.routesCovering(fromId, toId).map((item) => item.routeId);
    if (!covering.length) return false;
    const drivers = await this.prisma.user.findMany({
      where: { role: UserRole.DRIVER, isActive: true, deletedAt: null, driverProfile: { is: { approvalStatus: { in: ['APPROVED', 'ACTIVE'] }, routesServed: { hasSome: covering } } } },
      select: { vehicleType: true, maxLoadKg: true },
    });
    return drivers.length > 0 && drivers.every((driver) => vehicleCapacityKg(driver) < weightKg);
  }

  /**
   * Finds and assigns the best eligible driver for a leg that is waiting for one. Safe to call
   * repeatedly and concurrently: a leg that is no longer waiting is left alone.
   */
  async autoAssignLeg(legId: string): Promise<AssignOutcome> {
    // Candidates are ranked outside the lock; if every one of them changed before we could commit
    // (e.g. a concurrent assignment took the capacity), rank again from fresh state before giving up.
    let evaluation = await this.evaluateLeg(legId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { leg, network, ranked } = evaluation;
      if (leg.status !== ParcelLegStatus.AWAITING_DRIVER) return { assigned: false, reason: 'The leg is not waiting for a driver.', code: 'NOT_WAITING' };
      for (const candidate of ranked) {
        const committed = await this.commitOffer(leg.id, candidate.trip, SYSTEM_ACTOR, network);
        if (committed) {
          await this.afterOffer(committed, 'automatically');
          return { assigned: true, assignmentId: committed.id, driver: { id: candidate.trip.driverId, name: candidate.trip.driverName }, tripId: candidate.trip.tripId, acceptanceDeadline: committed.acceptanceDeadline! };
        }
      }
      if (!ranked.length) break;
      evaluation = await this.evaluateLeg(legId);
    }

    const { leg, network, trips, evaluations } = evaluation;
    if (leg.status !== ParcelLegStatus.AWAITING_DRIVER) return { assigned: false, reason: 'The leg is not waiting for a driver.', code: 'NOT_WAITING' };
    const code = diagnoseNoDriver({
      anyOpenTrip: trips.length > 0,
      segmentServed: network.routesCovering(leg.fromTransitPointId, leg.toTransitPointId).length > 0,
      heavierThanAllVehicles: await this.heavierThanAllVehicles(network, leg.fromTransitPointId, leg.toTransitPointId, leg.parcel.weight),
      evaluations,
    });
    await this.markWaiting(leg.id, code);
    return { assigned: false, reason: NO_DRIVER_MESSAGES[code], code };
  }

  /** Records why a leg is still waiting; the station is alerted once per waiting period, not on every retry. */
  private async markWaiting(legId: string, code: NoDriverReason) {
    const leg = await this.prisma.parcelLeg.findUnique({ where: { id: legId }, include: { parcel: true } });
    if (!leg || leg.status !== ParcelLegStatus.AWAITING_DRIVER) return;
    // The station is alerted once per waiting period; later retries only refresh the reason.
    const alertNeeded = !leg.attentionNotifiedAt;
    await this.prisma.parcelLeg.updateMany({
      where: { id: legId, status: ParcelLegStatus.AWAITING_DRIVER },
      data: { noDriverReason: code, lastAssignmentAttemptAt: new Date(), ...(alertNeeded ? { attentionNotifiedAt: new Date() } : {}) },
    });
    if (!alertNeeded) return;
    const station = await this.ctx.pointName(leg.fromTransitPointId);
    await this.ctx.notifyStation([leg.fromTransitPointId], {
      title: 'No eligible driver',
      message: `${leg.parcel.trackingNumber} is waiting at ${station} for a driver: ${NO_DRIVER_MESSAGES[code]}`,
      type: NotificationType.OFFICER_ACTION_REQUIRED,
      parcelId: leg.parcelId,
      actionUrl: '/transit-officer/dashboard',
    });
    this.ctx.emit('stationWorkUpdate', { kind: 'AWAITING_DRIVER', parcelId: leg.parcelId, legId, reason: code }, { transitPointIds: [leg.fromTransitPointId] });
  }

  /**
   * Creates the offer inside one transaction: lock the leg, lock the driver, re-evaluate against the
   * fresh trip position and load, then insert. Returns null when anything changed underneath.
   */
  private async commitOffer(legId: string, trip: CandidateTrip, assignedBy: string, network: RouteNetwork, options: { ignoreDeclined?: boolean } = {}): Promise<ParcelAssignment | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.ctx.lock(tx, 'parcel_legs', legId);
        const leg = await tx.parcelLeg.findUniqueOrThrow({ where: { id: legId }, include: { parcel: true } });
        if (leg.status !== ParcelLegStatus.AWAITING_DRIVER) return null;
        await this.ctx.lock(tx, 'users', trip.driverId);
        const excluded = options.ignoreDeclined ? new Set<string>() : await this.declinedPairs(legId, tx);
        const fresh = (await this.candidateTrips(tx, excluded)).find((item) => item.tripId === trip.tripId);
        if (!fresh) return null;
        const evaluation = evaluateTrip(network, fresh, { fromTransitPointId: leg.fromTransitPointId, toTransitPointId: leg.toTransitPointId, weightKg: leg.parcel.weight });
        if (!evaluation.eligible) return null;
        const now = new Date();
        const assignment = await tx.parcelAssignment.create({
          data: {
            parcelId: leg.parcelId, legId, tripId: trip.tripId, driverId: trip.driverId, assignedBy,
            status: AssignmentStatus.ASSIGNED, assignedAt: now, acceptanceDeadline: new Date(now.getTime() + ACCEPTANCE_WINDOW_MS),
            reservedWeightKg: leg.parcel.weight,
          },
        });
        await tx.parcelLeg.update({ where: { id: legId }, data: { status: ParcelLegStatus.DRIVER_ASSIGNED, noDriverReason: null, lastAssignmentAttemptAt: now, attentionNotifiedAt: null } });
        await tx.parcel.update({ where: { id: leg.parcelId }, data: { assignedAt: now, routeId: leg.routeId } });
        const station = await this.ctx.pointName(leg.fromTransitPointId, tx);
        await this.ctx.history(tx, {
          parcelId: leg.parcelId, status: leg.parcel.status, location: station, updatedBy: assignedBy,
          notes: `${leg.sequence > 1 ? 'Connecting driver' : 'Driver'} ${trip.driverName} assigned ${assignedBy === SYSTEM_ACTOR ? 'automatically' : 'by staff'} for ${station} → ${await this.ctx.pointName(leg.toTransitPointId, tx)}; acceptance required by ${formatDeadline(assignment.acceptanceDeadline!)}`,
        });
        await this.ctx.audit(tx, { userId: assignedBy, action: 'ASSIGNMENT_OFFERED', entityType: 'ParcelAssignment', entityId: assignment.id, after: { legId, tripId: trip.tripId, driverId: trip.driverId } });
        return assignment;
      }, TX_OPTIONS);
    } catch (error: any) {
      // Another request won the leg (one-active-assignment index) — treat as not assigned.
      if (error?.code === 'P2002') return null;
      throw error;
    }
  }

  private async afterOffer(assignment: ParcelAssignment, how: 'automatically' | 'by staff') {
    const leg = await this.prisma.parcelLeg.findUniqueOrThrow({ where: { id: assignment.legId! }, include: { parcel: true } });
    const [from, to] = await Promise.all([this.ctx.pointName(leg.fromTransitPointId), this.ctx.pointName(leg.toTransitPointId)]);
    await this.ctx.notifyUsers([assignment.driverId], {
      title: 'New parcel assignment',
      message: `${leg.parcel.trackingNumber} (${leg.parcel.weight} kg) was assigned to you ${how}: pick up at ${from}, drop at ${to}. Accept by ${assignment.acceptanceDeadline!.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}.`,
      type: NotificationType.ASSIGNMENT_OFFERED,
      parcelId: leg.parcelId,
      actionUrl: '/driver/my-parcels',
    });
    this.ctx.emit('assignmentUpdate', { assignmentId: assignment.id, parcelId: leg.parcelId, legId: leg.id, status: assignment.status, driverId: assignment.driverId, acceptanceDeadline: assignment.acceptanceDeadline }, { userIds: [assignment.driverId], transitPointIds: [leg.fromTransitPointId] });
  }

  /** Officer-triggered retry for one waiting leg at their station. */
  async retryLeg(legId: string, actor: Actor): Promise<AssignOutcome> {
    const leg = await this.prisma.parcelLeg.findUnique({ where: { id: legId } });
    if (!leg) throw new NotFoundException('Parcel leg not found');
    await this.ctx.assertStation(actor, leg.fromTransitPointId, 'Only the pickup station can retry this leg');
    return this.autoAssignLeg(legId);
  }

  /** Re-runs assignment for legs still waiting. Bounded, and silent unless a leg's reason changes. */
  async retryWaitingLegs(options: { olderThanMs?: number; limit?: number } = {}): Promise<number> {
    const legs = await this.prisma.parcelLeg.findMany({
      where: {
        status: ParcelLegStatus.AWAITING_DRIVER,
        ...(options.olderThanMs ? { OR: [{ lastAssignmentAttemptAt: null }, { lastAssignmentAttemptAt: { lt: new Date(Date.now() - options.olderThanMs) } }] } : {}),
      },
      orderBy: [{ activatedAt: 'asc' }, { id: 'asc' }],
      take: options.limit ?? 100,
      select: { id: true },
    });
    let assigned = 0;
    for (const leg of legs) {
      try {
        if ((await this.autoAssignLeg(leg.id)).assigned) assigned++;
      } catch (error) {
        this.logger.warn(`Retry for leg ${leg.id} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    return assigned;
  }

  /** Reassigns after releases, without letting one failure hide the others. */
  async reassign(legIds: (string | null | undefined)[]): Promise<void> {
    for (const legId of [...new Set(legIds.filter((id): id is string => !!id))]) {
      try { await this.autoAssignLeg(legId); } catch (error) { this.logger.warn(`Reassignment of leg ${legId} failed: ${error instanceof Error ? error.message : error}`); }
    }
  }

  /**
   * Ends an uncollected offer (ASSIGNED/ACCEPTED) and puts its leg back to AWAITING_DRIVER, inside the
   * caller's transaction. Returns false when the assignment had already moved on.
   */
  async releaseOffer(tx: Tx, assignment: Pick<ParcelAssignment, 'id' | 'legId' | 'parcelId' | 'driverId'>, reason: ReleaseReason, actorId: string, note?: string): Promise<boolean> {
    const now = new Date();
    const data = reason === 'REJECTED'
      ? { status: AssignmentStatus.REJECTED, rejectedAt: now, rejectionReason: note ?? null }
      : reason === 'EXPIRED'
        ? { status: AssignmentStatus.EXPIRED, expiredAt: now }
        : { status: AssignmentStatus.CANCELLED, cancelledAt: now, cancelledBy: actorId, cancellationReason: note ? `${RELEASE_TEXT[reason]}: ${note}` : RELEASE_TEXT[reason] };
    const updated = await tx.parcelAssignment.updateMany({
      where: { id: assignment.id, status: { in: ACTIVE_OFFER }, ...(reason === 'EXPIRED' ? { status: AssignmentStatus.ASSIGNED, acceptanceDeadline: { lt: now } } : {}) },
      data,
    });
    if (!updated.count) return false;
    if (assignment.legId) {
      await tx.parcelLeg.updateMany({ where: { id: assignment.legId, status: ParcelLegStatus.DRIVER_ASSIGNED }, data: { status: ParcelLegStatus.AWAITING_DRIVER, attentionNotifiedAt: null } });
    }
    const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: assignment.parcelId } });
    const driver = await tx.user.findUnique({ where: { id: assignment.driverId }, select: { name: true } });
    const text = reason === 'REJECTED' ? `rejected by ${driver?.name ?? 'the driver'}${note ? `: ${note}` : ''}`
      : reason === 'EXPIRED' ? `expired: ${driver?.name ?? 'the driver'} did not accept within 3 hours`
        : `withdrawn from ${driver?.name ?? 'the driver'}: ${RELEASE_TEXT[reason]}${note ? ` (${note})` : ''}`;
    await this.ctx.history(tx, { parcelId: parcel.id, status: parcel.status, location: parcel.currentLocation, updatedBy: actorId, notes: `Driver assignment ${text}. Looking for another driver.` });
    await this.ctx.audit(tx, { userId: actorId, action: `ASSIGNMENT_${reason}`, entityType: 'ParcelAssignment', entityId: assignment.id, after: { legId: assignment.legId, note } });
    return true;
  }

  /** Post-commit side of releaseOffer: tells the driver and refreshes the dashboards involved. */
  async afterRelease(assignmentId: string, reason: ReleaseReason) {
    const assignment = await this.prisma.parcelAssignment.findUnique({ where: { id: assignmentId }, include: { leg: true } });
    if (!assignment) return;
    const parcel = await this.prisma.parcel.findUnique({ where: { id: assignment.parcelId }, select: { trackingNumber: true } });
    if (reason !== 'REJECTED') {
      await this.ctx.notifyUsers([assignment.driverId], {
        title: reason === 'EXPIRED' ? 'Assignment expired' : 'Assignment withdrawn',
        message: reason === 'EXPIRED' ? `You did not accept ${parcel?.trackingNumber} within 3 hours, so it was offered to another driver.` : `${parcel?.trackingNumber} is no longer assigned to you: ${RELEASE_TEXT[reason as keyof typeof RELEASE_TEXT] ?? reason}.`,
        type: NotificationType.ASSIGNMENT_UPDATED,
        parcelId: assignment.parcelId,
        actionUrl: '/driver/my-parcels',
      });
    }
    this.ctx.emit('assignmentUpdate', { assignmentId, parcelId: assignment.parcelId, legId: assignment.legId, status: assignment.status, driverId: assignment.driverId }, { userIds: [assignment.driverId], transitPointIds: [assignment.leg?.fromTransitPointId] });
  }

  async accept(assignmentId: string, driverId: string) {
    const assignment = await this.prisma.parcelAssignment.findFirst({ where: { id: assignmentId, driverId }, include: { trip: true, leg: true } });
    if (!assignment) throw new NotFoundException('Assignment not found');
    if (assignment.status === AssignmentStatus.ACCEPTED || assignment.status === AssignmentStatus.COLLECTED) return { message: 'Assignment already accepted.', assignmentId, status: assignment.status };
    if (assignment.status !== AssignmentStatus.ASSIGNED) throw new ConflictException(`This assignment is ${assignment.status.toLowerCase()} and can no longer be accepted.`);
    if (!assignment.acceptanceDeadline || assignment.acceptanceDeadline <= new Date()) {
      await this.expireOne(assignmentId);
      throw new ConflictException('The 3-hour acceptance window has passed; the parcel was offered to another driver.');
    }
    const network = await this.ctx.network();
    const trip = assignment.trip;
    const stillAhead = !!trip && !!assignment.leg && (trip.status === TripStatus.CREATED || trip.status === TripStatus.IN_TRANSIT)
      && evaluateTrip(network, {
        tripId: trip.id, driverId, driverName: '', routeId: trip.routeId, direction: trip.direction, status: trip.status as 'CREATED' | 'IN_TRANSIT',
        currentTransitPointId: trip.currentTransitPointId ?? trip.startTransitPointId ?? '', atStop: trip.atStop, createdAt: trip.createdAt,
        capacityKg: Number.POSITIVE_INFINITY, reservedKg: 0, loadedKg: 0,
      }, { fromTransitPointId: assignment.leg.fromTransitPointId, toTransitPointId: assignment.leg.toTransitPointId, weightKg: 0 }).eligible;
    if (!stillAhead) {
      await this.cancelBySystem([assignmentId], 'PICKUP_PASSED');
      throw new ConflictException('Your trip has already passed the pickup station, so the parcel was offered to another driver.');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.parcelAssignment.updateMany({ where: { id: assignmentId, driverId, status: AssignmentStatus.ASSIGNED, acceptanceDeadline: { gt: new Date() } }, data: { status: AssignmentStatus.ACCEPTED, acceptedAt: new Date() } });
      if (!result.count) return false;
      const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: assignment.parcelId } });
      const driver = await tx.user.findUnique({ where: { id: driverId }, select: { name: true } });
      await this.ctx.history(tx, { parcelId: parcel.id, status: parcel.status, location: parcel.currentLocation, updatedBy: driverId, notes: `Driver ${driver?.name ?? ''} accepted the assignment and will collect the parcel.` });
      await this.ctx.audit(tx, { userId: driverId, action: 'ASSIGNMENT_ACCEPTED', entityType: 'ParcelAssignment', entityId: assignmentId });
      return true;
    }, TX_OPTIONS);
    const current = await this.prisma.parcelAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
    if (!updated && current.status !== AssignmentStatus.ACCEPTED) throw new ConflictException(`This assignment is ${current.status.toLowerCase()} and can no longer be accepted.`);
    this.ctx.emit('assignmentUpdate', { assignmentId, parcelId: current.parcelId, legId: current.legId, status: current.status, driverId }, { userIds: [driverId], transitPointIds: [assignment.leg?.fromTransitPointId] });
    return { message: 'Assignment accepted. Collect the parcel at the pickup station.', assignmentId, status: current.status };
  }

  async reject(assignmentId: string, driverId: string, reason: string) {
    const text = reason?.trim();
    if (!text || text.length < 5) throw new BadRequestException('A rejection reason of at least 5 characters is required');
    const assignment = await this.prisma.parcelAssignment.findFirst({ where: { id: assignmentId, driverId } });
    if (!assignment) throw new NotFoundException('Assignment not found');
    if (assignment.status === AssignmentStatus.REJECTED) return { message: 'Assignment already rejected.', assignmentId };
    if (!ACTIVE_OFFER.includes(assignment.status as typeof ACTIVE_OFFER[number])) throw new ConflictException(`This assignment is ${assignment.status.toLowerCase()} and cannot be rejected.`);
    const released = await this.prisma.$transaction((tx) => this.releaseOffer(tx, assignment, 'REJECTED', driverId, text), TX_OPTIONS);
    if (!released) throw new ConflictException('This assignment changed before it could be rejected; refresh and try again.');
    await this.afterRelease(assignmentId, 'REJECTED');
    await this.reassign([assignment.legId]);
    return { message: 'Assignment rejected. The parcel is being offered to another driver.', assignmentId };
  }

  /** A station officer (at the pickup station) or admin withdraws an offer that has not been collected. */
  async cancelByStaff(assignmentId: string, actor: Actor, reason: string, options: { autoReassign?: boolean } = {}) {
    const text = reason?.trim();
    if (!text || text.length < 5) throw new BadRequestException('A cancellation reason of at least 5 characters is required');
    const assignment = await this.prisma.parcelAssignment.findUnique({ where: { id: assignmentId }, include: { leg: true } });
    if (!assignment?.leg) throw new NotFoundException('Assignment not found');
    await this.ctx.assertStation(actor, assignment.leg.fromTransitPointId, 'Only the pickup station can cancel this assignment');
    if (assignment.status === AssignmentStatus.CANCELLED) return { message: 'Assignment already cancelled.', assignmentId };
    if (!ACTIVE_OFFER.includes(assignment.status as typeof ACTIVE_OFFER[number])) throw new ConflictException('Only assignments that have not been collected can be cancelled. A collected parcel needs a custody exception.');
    const released = await this.prisma.$transaction((tx) => this.releaseOffer(tx, assignment, 'OFFICER_CANCELLED', actor.id, text), TX_OPTIONS);
    if (!released) throw new ConflictException('This assignment changed before it could be cancelled; refresh and try again.');
    await this.afterRelease(assignmentId, 'OFFICER_CANCELLED');
    if (options.autoReassign === false) return { message: 'Assignment cancelled.', assignmentId, reassignment: null };
    const outcome = await this.autoAssignLeg(assignment.leg.id);
    return { message: outcome.assigned ? `Assignment cancelled and reassigned to ${outcome.driver.name}.` : `Assignment cancelled. ${outcome.reason}`, assignmentId, reassignment: outcome };
  }

  /** System withdrawals (pickup passed, trip ended, re-plan). Reassigns afterwards. */
  async cancelBySystem(assignmentIds: string[], reason: Exclude<ReleaseReason, 'REJECTED' | 'EXPIRED' | 'OFFICER_CANCELLED'>, reassign = true) {
    const released: string[] = [];
    const legIds: (string | null)[] = [];
    for (const id of assignmentIds) {
      const assignment = await this.prisma.parcelAssignment.findUnique({ where: { id } });
      if (!assignment) continue;
      const ok = await this.prisma.$transaction((tx) => this.releaseOffer(tx, assignment, reason, SYSTEM_ACTOR), TX_OPTIONS);
      if (ok) { released.push(id); legIds.push(assignment.legId); }
    }
    for (const id of released) await this.afterRelease(id, reason);
    if (reassign) await this.reassign(legIds);
    return released.length;
  }

  private async expireOne(assignmentId: string): Promise<boolean> {
    const assignment = await this.prisma.parcelAssignment.findUnique({ where: { id: assignmentId } });
    if (!assignment) return false;
    const expired = await this.prisma.$transaction((tx) => this.releaseOffer(tx, assignment, 'EXPIRED', SYSTEM_ACTOR), TX_OPTIONS);
    if (!expired) return false;
    await this.afterRelease(assignmentId, 'EXPIRED');
    await this.reassign([assignment.legId]);
    return true;
  }

  /** Server-side 3-hour acceptance timeout. Idempotent: an assignment accepted in time is untouched. */
  async expireOverdueOffers(now = new Date()): Promise<number> {
    const due = await this.prisma.parcelAssignment.findMany({ where: { status: AssignmentStatus.ASSIGNED, acceptanceDeadline: { lt: now } }, select: { id: true }, orderBy: { acceptanceDeadline: 'asc' }, take: 200 });
    let count = 0;
    for (const item of due) if (await this.expireOne(item.id)) count++;
    return count;
  }

  /** Exception control: staff choose a specific open trip for a waiting leg. The normal rules still apply. */
  async manualAssign(legId: string, tripId: string, actor: Actor) {
    const leg = await this.prisma.parcelLeg.findUnique({ where: { id: legId }, include: { parcel: true } });
    if (!leg) throw new NotFoundException('Parcel leg not found');
    await this.ctx.assertStation(actor, leg.fromTransitPointId, 'Only the pickup station can assign this leg');
    if (leg.status !== ParcelLegStatus.AWAITING_DRIVER) throw new ConflictException(leg.status === ParcelLegStatus.DRIVER_ASSIGNED ? 'This leg already has a driver; cancel that assignment first.' : 'This leg is not waiting for a driver.');
    const network = await this.ctx.network();
    const trip = (await this.candidateTrips()).find((item) => item.tripId === tripId);
    if (!trip) throw new BadRequestException('That trip is not open, or its driver is not active, approved and on duty for the route.');
    const evaluation = evaluateTrip(network, trip, { fromTransitPointId: leg.fromTransitPointId, toTransitPointId: leg.toTransitPointId, weightKg: leg.parcel.weight });
    if (!evaluation.eligible && evaluation.reason !== 'DECLINED') throw new BadRequestException(`That driver is not eligible: ${evaluation.reason.replaceAll('_', ' ').toLowerCase()}.`);
    const assignment = await this.commitOffer(legId, trip, actor.id, network, { ignoreDeclined: true });
    if (!assignment) throw new ConflictException('The leg or the driver changed while assigning; refresh and try again.');
    await this.afterOffer(assignment, 'by staff');
    return { assignmentId: assignment.id, driver: { id: trip.driverId, name: trip.driverName }, tripId, acceptanceDeadline: assignment.acceptanceDeadline };
  }

  /** Every open trip with its eligibility for a leg, for the officer's exception screen. */
  async eligibleDrivers(legId: string, actor: Actor) {
    const leg = await this.prisma.parcelLeg.findUnique({ where: { id: legId } });
    if (!leg) throw new NotFoundException('Parcel leg not found');
    await this.ctx.assertStation(actor, leg.fromTransitPointId, 'Only the pickup station can view drivers for this leg');
    const { evaluations, ranked } = await this.evaluateLeg(legId, { ignoreDeclined: false });
    const rank = new Map(ranked.map((item, index) => [item.trip.tripId, index + 1]));
    return evaluations.map((item: Evaluation) => ({
      tripId: item.trip.tripId,
      driverId: item.trip.driverId,
      driverName: item.trip.driverName,
      routeId: item.trip.routeId,
      direction: item.trip.direction,
      tripStatus: item.trip.status,
      capacityKg: item.trip.capacityKg,
      availableKg: Math.max(0, item.trip.capacityKg - item.trip.reservedKg - item.trip.loadedKg),
      eligible: item.eligible,
      rank: rank.get(item.trip.tripId) ?? null,
      tier: item.eligible ? item.tier : null,
      distanceKm: item.eligible && item.distanceKm != null ? Math.round(item.distanceKm * 10) / 10 : null,
      reason: item.eligible ? null : item.reason,
    })).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  }
}
