import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AlertStatus, AssignmentStatus, CustodyHolder, NotificationType, Parcel, ParcelLeg, ParcelLegStatus, ParcelStatus, PaymentStatus, TamperAlertType, TripStatus, UserRole,
} from '@prisma/client';
import * as QRCode from 'qrcode';
import { MailerService } from '../../mailer/mailer.service';
import { PlannedLeg, RouteNetwork } from '../../common/route-planner';
import { DispatchService } from './dispatch.service';
import { CollectionService } from './collection.service';
import { Actor, SYSTEM_ACTOR, TX_OPTIONS, Tx, WorkflowContext } from './workflow-context.service';
import { formatDeadline } from './dispatch-rules';

export const NO_ROUTE_AVAILABLE = 'NO_ROUTE_AVAILABLE';

/**
 * What happened to a parcel once a station took custody of it; drives the follow-up after commit.
 * `released` lists driver offers withdrawn inside the transaction (announced after commit) and
 * `stationIds` every station whose queues the change touches.
 */
export type Settlement = (
  | { kind: 'FINAL'; parcelId: string }
  | { kind: 'TRANSFER'; parcelId: string; nextLegId: string; stationId: string }
  | { kind: 'RETURNED'; parcelId: string; legId: string }
  | { kind: 'REPLANNED'; parcelId: string; nextLegId: string }
  | { kind: 'ROUTE_BLOCKED'; parcelId: string; alertId: string }
) & { released?: string[]; stationIds?: (string | null | undefined)[] };

const TERMINAL_LEG: ParcelLegStatus[] = [ParcelLegStatus.COMPLETED, ParcelLegStatus.CANCELLED];
const CLOSED_PARCEL: ParcelStatus[] = [ParcelStatus.delivered, ParcelStatus.completed, ParcelStatus.cancelled, ParcelStatus.returned];

/**
 * The parcel journey: planning at origin confirmation (then frozen as legs), moving from leg to leg as
 * stations verify handovers, explicit audited re-planning, route deactivation, and cancellation.
 */
@Injectable()
export class JourneyService {
  private readonly logger = new Logger(JourneyService.name);

  constructor(
    private readonly ctx: WorkflowContext,
    private readonly dispatch: DispatchService,
    private readonly collection: CollectionService,
    private readonly mailer: MailerService,
  ) {}

  private get prisma() { return this.ctx.prisma; }

  /** Validates that a journey exists between two stations and returns its legs (not persisted). */
  async planPreview(originTransitPointId: string, destinationTransitPointId: string, network?: RouteNetwork): Promise<{ legs: PlannedLeg[]; summary: string }> {
    if (originTransitPointId === destinationTransitPointId) throw new BadRequestException('Origin and destination must be different transit points');
    network ??= await this.ctx.network();
    const origin = network.point(originTransitPointId);
    const destination = network.point(destinationTransitPointId);
    if (!origin || origin.active === false) throw new BadRequestException('The origin transit point is not active');
    if (!destination || destination.active === false) throw new BadRequestException('The destination transit point is not active');
    const legs = network.plan(originTransitPointId, destinationTransitPointId, { servedRouteIds: await this.ctx.servedRouteIds() });
    if (!legs?.length) throw new BadRequestException({ code: NO_ROUTE_AVAILABLE, message: `${NO_ROUTE_AVAILABLE}: no active route connection exists from ${origin.name} to ${destination.name}` });
    return { legs, summary: network.describe(legs) };
  }

  private async insertLegs(tx: Tx, parcelId: string, legs: PlannedLeg[], startSequence: number, now: Date, network: RouteNetwork): Promise<{ firstLegId: string; blocked: boolean }> {
    let firstLegId = '';
    let blocked = false;
    for (const [index, planned] of legs.entries()) {
      const first = index === 0;
      const usable = network.routesCovering(planned.fromTransitPointId, planned.toTransitPointId).length > 0;
      const leg = await tx.parcelLeg.create({
        data: {
          parcelId, sequence: startSequence + index, routeId: planned.routeId, direction: planned.direction,
          fromTransitPointId: planned.fromTransitPointId, toTransitPointId: planned.toTransitPointId,
          isFinal: index === legs.length - 1, distanceKm: planned.distanceKm,
          status: first ? (usable ? ParcelLegStatus.AWAITING_DRIVER : ParcelLegStatus.EXCEPTION) : ParcelLegStatus.PLANNED,
          activatedAt: first ? now : null,
        },
      });
      if (first) { firstLegId = leg.id; blocked = !usable; }
    }
    return { firstLegId, blocked };
  }

  /**
   * Origin officer confirms physical receipt. Re-validates the stations, weight and route, freezes the
   * journey as legs and starts automatic assignment for leg 1. Idempotent under double submission.
   */
  async confirmAtOrigin(parcelId: string, actor: Actor) {
    const parcel = await this.prisma.parcel.findFirst({ where: { id: parcelId, deletedAt: null } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    const originId = parcel.originTransitPointId ?? parcel.currentTransitPointId;
    await this.ctx.assertStation(actor, originId, 'You can only confirm parcels received at your assigned transit point');
    if (parcel.status !== ParcelStatus.awaiting_confirmation) {
      if (parcel.originConfirmedAt) return this.confirmationResult(parcel.id, { alreadyConfirmed: true });
      throw new BadRequestException(`Parcel is ${parcel.status.replaceAll('_', ' ')} and cannot be confirmed`);
    }
    if (!originId || !parcel.destinationTransitPointId) throw new BadRequestException('The parcel needs an origin and a destination transit point before confirmation');
    if (!(parcel.weight > 0)) throw new BadRequestException('Record the parcel weight before confirming it');
    const network = await this.ctx.network();
    const { legs, summary } = await this.planPreview(originId, parcel.destinationTransitPointId, network);

    const now = new Date();
    const confirmed = await this.prisma.$transaction(async (tx) => {
      await this.ctx.lock(tx, 'parcels', parcel.id);
      const updated = await tx.parcel.updateMany({
        where: { id: parcel.id, status: ParcelStatus.awaiting_confirmation },
        data: {
          status: ParcelStatus.at_origin_transit_point, custody: CustodyHolder.STATION, originTransitPointId: originId,
          currentTransitPointId: originId, currentLocation: network.point(originId)?.name, originConfirmedAt: now, originConfirmedBy: actor.id, routeId: legs[0].routeId,
          // The fee is collected at the counter when the parcel is handed over.
          paymentStatus: PaymentStatus.PAID,
        },
      });
      if (!updated.count) return null;
      const { firstLegId } = await this.insertLegs(tx, parcel.id, legs, 1, now, network);
      await this.ctx.history(tx, {
        parcelId: parcel.id, status: ParcelStatus.at_origin_transit_point, location: network.point(originId)?.name, updatedBy: actor.id,
        notes: `Parcel physically received and confirmed at ${network.point(originId)?.name}${actor.role === UserRole.ADMIN ? ' (recorded by admin)' : ''}. Journey: ${summary}. Delivery fee paid at the counter.`,
      });
      await this.ctx.audit(tx, { userId: actor.id, action: 'PARCEL_ORIGIN_CONFIRMED', entityType: 'Parcel', entityId: parcel.id, after: { legs: legs.map((leg) => ({ routeId: leg.routeId, from: leg.fromTransitPointId, to: leg.toTransitPointId })) } });
      return firstLegId;
    }, TX_OPTIONS);
    if (!confirmed) return this.confirmationResult(parcel.id, { alreadyConfirmed: true });

    const fresh = await this.prisma.parcel.findUniqueOrThrow({ where: { id: parcel.id } });
    // Email goes out in the background: a slow or unreachable mail server must not hold up the counter.
    void this.sendConfirmationEmails(fresh, network.point(originId)?.name ?? fresh.pickupAddress);
    await this.ctx.notifyParties(fresh, { title: 'Parcel received', message: `${fresh.trackingNumber} was received at ${network.point(originId)?.name}. Route: ${summary}.`, type: NotificationType.PARCEL_IN_TRANSIT });
    const outcome = await this.dispatch.autoAssignLeg(confirmed);
    return this.confirmationResult(parcel.id, { assignment: outcome });
  }

  private async confirmationResult(parcelId: string, extra: object) {
    const parcel = await this.prisma.parcel.findUniqueOrThrow({ where: { id: parcelId } });
    const legs = await this.prisma.parcelLeg.findMany({ where: { parcelId }, orderBy: { sequence: 'asc' }, include: { assignments: { where: { status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED, AssignmentStatus.COLLECTED] } } } } });
    const current = legs.find((leg) => !TERMINAL_LEG.includes(leg.status));
    const active = current?.assignments[0];
    const driver = active ? await this.prisma.user.findUnique({ where: { id: active.driverId }, select: { id: true, name: true } }) : null;
    const receiptPayload = JSON.stringify({ type: 'SENDIT_TRANSIT_RECEIPT', trackingNumber: parcel.trackingNumber, seal: parcel.qrSealIdentifier, confirmedAt: parcel.originConfirmedAt });
    const assigned = !!active;
    return {
      message: assigned
        ? `Parcel confirmed and assigned automatically to ${driver?.name}; acceptance required by ${active!.acceptanceDeadline ? formatDeadline(active!.acceptanceDeadline) : 'soon'}.`
        : `Parcel confirmed. Waiting for a driver: ${(extra as any).assignment?.reason ?? current?.noDriverReason ?? 'no eligible driver yet'}`,
      parcel,
      autoAssigned: assigned,
      driver,
      acceptanceDeadline: active?.acceptanceDeadline ?? null,
      noDriverReason: current?.noDriverReason ?? null,
      legs,
      receipt: { trackingNumber: parcel.trackingNumber, sealIdentifier: parcel.qrSealIdentifier, qrDataUrl: await QRCode.toDataURL(receiptPayload, { errorCorrectionLevel: 'H', margin: 1, width: 280 }) },
      ...extra,
    };
  }

  private async sendConfirmationEmails(parcel: Parcel, confirmedLocation: string) {
    const context = {
      trackingNumber: parcel.trackingNumber, status: 'Confirmed at transit point', confirmedLocation,
      senderName: parcel.senderName, senderEmail: parcel.senderEmail, senderPhone: parcel.senderPhone,
      recipientName: parcel.recipientName, recipientEmail: parcel.recipientEmail, recipientPhone: parcel.recipientPhone,
      pickupAddress: parcel.pickupAddress, deliveryAddress: parcel.deliveryAddress, weight: parcel.weight,
      description: parcel.description || 'Not provided', value: parcel.value ?? 'Not declared', deliveryFee: parcel.deliveryFee ?? 'To be confirmed',
      deliveryInstructions: parcel.deliveryInstructions || 'None',
    };
    const recipients = [
      { email: parcel.senderEmail, name: parcel.senderName, role: 'sender' },
      { email: parcel.recipientEmail, name: parcel.recipientName, role: 'recipient' },
    ].filter((item, index, all) => !!item.email && all.findIndex((other) => other.email.toLowerCase() === item.email.toLowerCase()) === index);
    await Promise.allSettled(recipients.map((recipient) => this.mailer.sendGenericEmail({
      to: recipient.email, subject: `Parcel confirmed: ${parcel.trackingNumber}`, template: 'parcel-confirmed',
      context: { ...context, name: recipient.name, recipientRole: recipient.role },
    }).catch((error) => this.logger.warn(`Confirmation email to ${recipient.email} failed: ${error?.message ?? error}`))));
  }

  /**
   * A station now physically holds the parcel (verified handover, exception handover, or custody
   * correction). Inside the caller's transaction this ends any driver custody at that station and moves
   * the journey on: next leg, final collection, back to the same leg's pickup, or an audited re-plan.
   */
  async settleAtStation(tx: Tx, network: RouteNetwork, input: { parcelId: string; stationId: string; actorId: string; reason: string }): Promise<Settlement> {
    const now = new Date();
    const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: input.parcelId } });
    const station = network.point(input.stationId)?.name ?? (await this.ctx.pointName(input.stationId, tx));
    const legs = await tx.parcelLeg.findMany({ where: { parcelId: parcel.id }, orderBy: { sequence: 'asc' } });
    const current = legs.find((leg) => !TERMINAL_LEG.includes(leg.status));

    // Driver custody (if any) ends here.
    await tx.parcelAssignment.updateMany({
      where: { parcelId: parcel.id, status: { in: [AssignmentStatus.COLLECTED, AssignmentStatus.DROPPED] } },
      data: { status: AssignmentStatus.COMPLETED, completedAt: now, dropTransitPointId: input.stationId },
    });
    await tx.parcelAssignment.updateMany({ where: { parcelId: parcel.id, droppedAt: null, status: AssignmentStatus.COMPLETED, completedAt: now }, data: { droppedAt: now } });

    const inStation = { custody: CustodyHolder.STATION, currentTransitPointId: input.stationId, currentLocation: station };
    if (current && current.toTransitPointId === input.stationId) {
      await tx.parcelLeg.update({ where: { id: current.id }, data: { status: ParcelLegStatus.COMPLETED, completedAt: now, droppedAt: current.droppedAt ?? now } });
      if (current.isFinal) {
        await this.collection.markReadyAtStation(tx, { ...parcel, ...inStation } as Parcel, input.stationId, input.actorId, now);
        return { kind: 'FINAL', parcelId: parcel.id };
      }
      const next = legs.find((leg) => leg.sequence > current.sequence && leg.status === ParcelLegStatus.PLANNED);
      if (next) return this.activateLeg(tx, network, parcel, next, input, station, `Arrived and verified at transfer station ${station}; waiting for the connecting route to ${network.point(next.toTransitPointId)?.name}.`);
    }

    if (current && current.fromTransitPointId === input.stationId && current.status !== ParcelLegStatus.PLANNED) {
      // Handed back at the leg's own pickup station (trip cancelled or parcel returned before departure).
      const open = await tx.parcelAssignment.findMany({ where: { legId: current.id, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] } } });
      const released: string[] = [];
      for (const offer of open) if (await this.dispatch.releaseOffer(tx, offer, 'JOURNEY_REPLANNED', input.actorId)) released.push(offer.id);
      await tx.parcelLeg.update({ where: { id: current.id }, data: { status: ParcelLegStatus.AWAITING_DRIVER, collectedAt: null, droppedAt: null, activatedAt: now, noDriverReason: null, attentionNotifiedAt: null } });
      const status = current.sequence === 1 ? ParcelStatus.at_origin_transit_point : ParcelStatus.at_transit_point;
      await tx.parcel.update({ where: { id: parcel.id }, data: { ...inStation, status, routeId: current.routeId } });
      await this.ctx.history(tx, { parcelId: parcel.id, status, location: station, updatedBy: input.actorId, notes: `Back in custody at ${station} (${input.reason}); a new driver will be assigned for the same leg.` });
      return { kind: 'RETURNED', parcelId: parcel.id, legId: current.id, released, stationIds: [current.fromTransitPointId, current.toTransitPointId] };
    }

    // Anywhere else: the remaining journey is re-planned from this station (audited, never silent).
    return this.replanFrom(tx, network, parcel, legs, input.stationId, input.actorId, input.reason);
  }

  private async activateLeg(tx: Tx, network: RouteNetwork, parcel: Parcel, leg: ParcelLeg, input: { stationId: string; actorId: string }, station: string, notes: string): Promise<Settlement> {
    const usable = network.routesCovering(leg.fromTransitPointId, leg.toTransitPointId).length > 0;
    await tx.parcel.update({ where: { id: parcel.id }, data: { status: ParcelStatus.at_transit_point, custody: CustodyHolder.STATION, currentTransitPointId: input.stationId, currentLocation: station, routeId: leg.routeId } });
    if (!usable) {
      await tx.parcelLeg.update({ where: { id: leg.id }, data: { status: ParcelLegStatus.EXCEPTION, activatedAt: new Date() } });
      await this.ctx.history(tx, { parcelId: parcel.id, status: ParcelStatus.at_transit_point, location: station, updatedBy: input.actorId, notes: `${notes} The connecting route is no longer available; staff will arrange the onward journey.` });
      const { alert } = await this.ctx.raiseAlert(tx, { parcelId: parcel.id, type: TamperAlertType.ROUTE_UNAVAILABLE, transitPointId: input.stationId, legId: leg.id, details: `No active route serves ${station} → ${network.point(leg.toTransitPointId)?.name}. Re-plan the remaining journey.` });
      return { kind: 'ROUTE_BLOCKED', parcelId: parcel.id, alertId: alert.id };
    }
    await tx.parcelLeg.update({ where: { id: leg.id }, data: { status: ParcelLegStatus.AWAITING_DRIVER, activatedAt: new Date(), noDriverReason: null, attentionNotifiedAt: null } });
    await this.ctx.history(tx, { parcelId: parcel.id, status: ParcelStatus.at_transit_point, location: station, updatedBy: input.actorId, notes });
    return { kind: 'TRANSFER', parcelId: parcel.id, nextLegId: leg.id, stationId: input.stationId };
  }

  private async replanFrom(tx: Tx, network: RouteNetwork, parcel: Parcel, legs: ParcelLeg[], stationId: string, actorId: string, reason: string, destinationId = parcel.destinationTransitPointId): Promise<Settlement> {
    const now = new Date();
    const station = network.point(stationId)?.name ?? stationId;
    // Uncollected offers on the abandoned legs are withdrawn; the legs themselves are closed.
    const open = await tx.parcelAssignment.findMany({ where: { parcelId: parcel.id, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] } } });
    const released: string[] = [];
    for (const offer of open) if (await this.dispatch.releaseOffer(tx, offer, 'JOURNEY_REPLANNED', actorId)) released.push(offer.id);
    // Stations on the abandoned legs lose the parcel from their queues and must refresh too.
    const stationIds: (string | null | undefined)[] = [stationId, destinationId, ...legs.filter((leg) => !TERMINAL_LEG.includes(leg.status)).flatMap((leg) => [leg.fromTransitPointId, leg.toTransitPointId])];
    await tx.parcelLeg.updateMany({ where: { parcelId: parcel.id, status: { notIn: TERMINAL_LEG } }, data: { status: ParcelLegStatus.CANCELLED } });
    if (!destinationId) throw new BadRequestException('The parcel has no destination transit point');

    if (stationId === destinationId) {
      await tx.parcelLeg.create({ data: { parcelId: parcel.id, sequence: (legs.at(-1)?.sequence ?? 0) + 1, routeId: parcel.routeId ?? legs.at(-1)?.routeId ?? '', direction: legs.at(-1)?.direction ?? 'FORWARD', fromTransitPointId: stationId, toTransitPointId: stationId, isFinal: true, status: ParcelLegStatus.COMPLETED, activatedAt: now, completedAt: now, distanceKm: 0 } });
      await this.collection.markReadyAtStation(tx, parcel, stationId, actorId, now);
      await this.ctx.resolveAlerts(tx, parcel.id, [TamperAlertType.ROUTE_UNAVAILABLE], 'Parcel is already at its destination', actorId);
      return { kind: 'FINAL', parcelId: parcel.id, released, stationIds };
    }
    const planned = network.plan(stationId, destinationId);
    const onOrigin = !legs.some((leg) => leg.collectedAt) && stationId === parcel.originTransitPointId;
    const waitingStatus = onOrigin ? ParcelStatus.at_origin_transit_point : ParcelStatus.at_transit_point;
    await tx.parcel.update({ where: { id: parcel.id }, data: { custody: CustodyHolder.STATION, currentTransitPointId: stationId, currentLocation: station, status: waitingStatus } });
    if (!planned?.length) {
      await this.ctx.history(tx, { parcelId: parcel.id, status: waitingStatus, location: station, updatedBy: actorId, notes: `In custody at ${station} (${reason}). No active route currently reaches the destination; staff will arrange the onward journey.` });
      const { alert } = await this.ctx.raiseAlert(tx, { parcelId: parcel.id, type: TamperAlertType.ROUTE_UNAVAILABLE, transitPointId: stationId, details: `No active route from ${station} to ${network.point(destinationId)?.name}. Activate a route, then re-plan.` });
      return { kind: 'ROUTE_BLOCKED', parcelId: parcel.id, alertId: alert.id, released, stationIds };
    }
    const { firstLegId } = await this.insertLegs(tx, parcel.id, planned, (legs.at(-1)?.sequence ?? 0) + 1, now, network);
    await tx.parcel.update({ where: { id: parcel.id }, data: { routeId: planned[0].routeId } });
    await this.ctx.history(tx, { parcelId: parcel.id, status: waitingStatus, location: station, updatedBy: actorId, notes: `Journey re-planned from ${station} (${reason}): ${network.describe(planned)}.` });
    await this.ctx.audit(tx, { userId: actorId, action: 'JOURNEY_REPLANNED', entityType: 'Parcel', entityId: parcel.id, after: { fromTransitPointId: stationId, reason, legs: planned.map((leg) => leg.routeId) } });
    await this.ctx.resolveAlerts(tx, parcel.id, [TamperAlertType.ROUTE_UNAVAILABLE], 'Journey re-planned', actorId);
    return { kind: 'REPLANNED', parcelId: parcel.id, nextLegId: firstLegId, released, stationIds: [...stationIds, ...planned.flatMap((leg) => [leg.fromTransitPointId, leg.toTransitPointId])] };
  }

  /** Follow-up once the settling transaction committed: assignment, collection, notifications. */
  async afterSettlement(settlement: Settlement): Promise<void> {
    const parcel = await this.prisma.parcel.findUnique({ where: { id: settlement.parcelId } });
    if (!parcel) return;
    // Drivers whose offers were withdrawn inside the transaction are told now, after commit.
    for (const assignmentId of settlement.released ?? []) await this.dispatch.afterRelease(assignmentId, 'JOURNEY_REPLANNED');
    this.ctx.emit('parcelStatusUpdate', { parcelId: parcel.id, status: parcel.status, custody: parcel.custody, location: parcel.currentLocation, kind: settlement.kind }, {
      userIds: [parcel.senderId, parcel.recipientId],
      transitPointIds: [parcel.currentTransitPointId, parcel.originTransitPointId, parcel.destinationTransitPointId, ...(settlement.stationIds ?? [])],
    });
    switch (settlement.kind) {
      case 'FINAL':
        await this.collection.startFinalCollection(parcel.id);
        return;
      case 'TRANSFER': {
        const next = await this.prisma.parcelLeg.findUnique({ where: { id: settlement.nextLegId } });
        await this.ctx.notifyParties(parcel, { title: 'At transfer station', message: `${parcel.trackingNumber} reached ${parcel.currentLocation} and continues on a connecting route to ${await this.ctx.pointName(next?.toTransitPointId)}.`, type: NotificationType.PARCEL_IN_TRANSIT });
        await this.dispatch.autoAssignLeg(settlement.nextLegId);
        return;
      }
      case 'RETURNED':
        await this.dispatch.autoAssignLeg(settlement.legId);
        return;
      case 'REPLANNED':
        await this.ctx.notifyParties(parcel, { title: 'Journey updated', message: `${parcel.trackingNumber} will continue from ${parcel.currentLocation} on an updated route.`, type: NotificationType.PARCEL_IN_TRANSIT });
        await this.dispatch.autoAssignLeg(settlement.nextLegId);
        return;
      case 'ROUTE_BLOCKED': {
        const alert = await this.prisma.tamperAlert.findUnique({ where: { id: settlement.alertId } });
        if (alert) await this.ctx.announceAlert(alert, parcel.trackingNumber);
        return;
      }
    }
  }

  /**
   * Explicit re-plan by the officer at the parcel's current station (or an admin), e.g. after a route
   * was deactivated. Only an admin may change the destination.
   */
  async replan(parcelId: string, actor: Actor, data: { reason: string; destinationTransitPointId?: string }) {
    const reason = data.reason?.trim();
    if (!reason || reason.length < 5) throw new BadRequestException('A reason of at least 5 characters is required to re-plan a journey');
    const parcel = await this.prisma.parcel.findFirst({ where: { id: parcelId, deletedAt: null } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    await this.ctx.assertStation(actor, parcel.currentTransitPointId, 'Only the station holding the parcel can re-plan its journey');
    if (data.destinationTransitPointId && data.destinationTransitPointId !== parcel.destinationTransitPointId && actor.role !== UserRole.ADMIN) throw new BadRequestException('Only an administrator can change a confirmed parcel\'s destination');
    if (parcel.custody !== CustodyHolder.STATION || !parcel.currentTransitPointId || CLOSED_PARCEL.includes(parcel.status) || parcel.status === ParcelStatus.awaiting_confirmation) {
      throw new ConflictException('A journey can only be re-planned while a station holds the parcel');
    }
    if (parcel.status === ParcelStatus.in_locker || parcel.status === ParcelStatus.locker_assigned) throw new ConflictException('Release the locker before re-planning');
    const network = await this.ctx.network();
    const stationId = parcel.currentTransitPointId;
    const destinationId = data.destinationTransitPointId || parcel.destinationTransitPointId;
    if (!destinationId) throw new BadRequestException('The parcel has no destination transit point');
    const destination = network.point(destinationId);
    if (!destination || destination.active === false) throw new BadRequestException('The destination transit point is not active');
    // Refuse up front rather than tearing down the current journey for one that cannot run.
    if (stationId !== destinationId && !network.plan(stationId, destinationId)?.length) {
      throw new BadRequestException({ code: NO_ROUTE_AVAILABLE, message: `${NO_ROUTE_AVAILABLE}: no active route connection exists from ${network.point(stationId)?.name ?? 'this station'} to ${destination.name}. Activate a route first.` });
    }
    const previousDestinationId = parcel.destinationTransitPointId;
    const destinationChanged = destinationId !== previousDestinationId;
    const settlement = await this.prisma.$transaction(async (tx) => {
      await this.ctx.lock(tx, 'parcels', parcel.id);
      if (destinationChanged) {
        const previous = previousDestinationId ? network.point(previousDestinationId)?.name ?? parcel.deliveryAddress : parcel.deliveryAddress;
        await tx.parcel.update({ where: { id: parcel.id }, data: { destinationTransitPointId: destinationId, deliveryAddress: destination.name, readyForCollectionAt: null, collectionDeadlineAt: null, collectionOverdueAlertedAt: null } });
        // Locker holds and requests were made for the old destination; smart-locker parcels get a fresh request.
        const openRequest = await tx.lockerRequest.findFirst({ where: { parcelId: parcel.id, status: { in: ['PENDING', 'RESERVED', 'UNAVAILABLE'] } }, orderBy: { createdAt: 'desc' } });
        await this.collection.releaseLockers(tx, parcel.id, actor.id);
        if (parcel.deliveryMethod === 'SMART_LOCKER' && openRequest) {
          await tx.lockerRequest.create({ data: { parcelId: parcel.id, requestedBy: openRequest.requestedBy, size: openRequest.size, requestedMinutes: openRequest.requestedMinutes } });
        }
        await this.ctx.history(tx, { parcelId: parcel.id, status: parcel.status, location: parcel.currentLocation, updatedBy: actor.id, notes: `Destination changed from ${previous} to ${destination.name}: ${reason}` });
        await this.ctx.audit(tx, { userId: actor.id, action: 'PARCEL_DESTINATION_CORRECTED', entityType: 'Parcel', entityId: parcel.id, after: { from: previousDestinationId, to: destinationId, reason } });
      }
      const fresh = await tx.parcel.findUniqueOrThrow({ where: { id: parcel.id } });
      const legs = await tx.parcelLeg.findMany({ where: { parcelId: parcel.id }, orderBy: { sequence: 'asc' } });
      return this.replanFrom(tx, network, fresh, legs, stationId!, actor.id, reason, destinationId);
    }, TX_OPTIONS);
    settlement.stationIds = [...(settlement.stationIds ?? []), previousDestinationId];
    if (destinationChanged) {
      const notice = { title: 'Destination changed', message: `${parcel.trackingNumber} will now be delivered to ${destination.name} (${reason}).`, type: NotificationType.PARCEL_IN_TRANSIT };
      await this.ctx.notifyParties(parcel, notice);
      await this.ctx.notifyStation([previousDestinationId, destinationId], { ...notice, parcelId: parcel.id, actionUrl: '/transit-officer/dashboard' });
    }
    await this.afterSettlement(settlement);
    const message = settlement.kind === 'FINAL'
      ? `${parcel.trackingNumber} is already at ${destination.name} and is now ready for collection.`
      : settlement.kind === 'ROUTE_BLOCKED'
        ? `${parcel.trackingNumber} could not be re-planned: no active route reaches ${destination.name}.`
        : `${parcel.trackingNumber}'s journey was re-planned${destinationChanged ? ` to ${destination.name}` : ''}; a driver is being assigned for the first leg.`;
    return { message, settlement, journey: await this.journeyView(parcel.id, 'staff') };
  }

  /** The sender changed stations before hand-over: old and new origin/destination queues refresh. */
  announceBookingChange(parcel: Pick<Parcel, 'id' | 'senderId' | 'recipientId' | 'status'>, stationIds: (string | null | undefined)[]) {
    this.ctx.emit('parcelStatusUpdate', { parcelId: parcel.id, status: parcel.status, kind: 'BOOKING_UPDATED' }, { userIds: [parcel.senderId, parcel.recipientId], transitPointIds: stationIds });
  }

  /**
   * A route was deactivated. Journeys that have not started are re-planned automatically; journeys
   * already under way get an exception for the station to handle. Legs on the road finish normally.
   */
  async onRouteDeactivated(routeId: string, actorId: string) {
    const network = await this.ctx.network();
    const affected = await this.prisma.parcelLeg.findMany({ where: { routeId, status: { in: [ParcelLegStatus.PLANNED, ParcelLegStatus.AWAITING_DRIVER, ParcelLegStatus.DRIVER_ASSIGNED] } }, include: { parcel: true } });
    const byParcel = new Map<string, typeof affected>();
    for (const leg of affected) byParcel.set(leg.parcelId, [...(byParcel.get(leg.parcelId) ?? []), leg]);
    const results = { replanned: 0, flagged: 0 };
    for (const [parcelId, legs] of byParcel) {
      // Another active route may still cover the same stretch; then nothing needs to change.
      if (legs.every((leg) => network.routesCovering(leg.fromTransitPointId, leg.toTransitPointId).length > 0)) continue;
      const allLegs = await this.prisma.parcelLeg.findMany({ where: { parcelId }, orderBy: { sequence: 'asc' } });
      const started = allLegs.some((leg) => leg.collectedAt);
      const parcel = legs[0].parcel;
      const current = allLegs.find((leg) => !TERMINAL_LEG.includes(leg.status));
      if (!started && parcel.custody === CustodyHolder.STATION && parcel.currentTransitPointId) {
        const settlement = await this.prisma.$transaction(async (tx) => {
          const fresh = await tx.parcel.findUniqueOrThrow({ where: { id: parcelId } });
          return this.replanFrom(tx, network, fresh, allLegs, parcel.currentTransitPointId!, actorId, 'route deactivated before the journey started');
        }, TX_OPTIONS);
        results.replanned++;
        await this.afterSettlement(settlement);
        continue;
      }
      const waitingHere = current && legs.some((leg) => leg.id === current.id) && parcel.custody === CustodyHolder.STATION;
      const released: string[] = [];
      const alert = await this.prisma.$transaction(async (tx) => {
        if (waitingHere) {
          const open = await tx.parcelAssignment.findMany({ where: { legId: current!.id, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] } } });
          for (const offer of open) if (await this.dispatch.releaseOffer(tx, offer, 'ROUTE_UNAVAILABLE', actorId)) released.push(offer.id);
          await tx.parcelLeg.update({ where: { id: current!.id }, data: { status: ParcelLegStatus.EXCEPTION } });
        }
        const blocked = legs.find((leg) => !network.routesCovering(leg.fromTransitPointId, leg.toTransitPointId).length)!;
        await this.ctx.history(tx, { parcelId, status: parcel.status, location: parcel.currentLocation, updatedBy: actorId, notes: `A route on this parcel's journey (${network.point(blocked.fromTransitPointId)?.name} → ${network.point(blocked.toTransitPointId)?.name}) was deactivated; staff will arrange the onward journey.` });
        return (await this.ctx.raiseAlert(tx, { parcelId, type: TamperAlertType.ROUTE_UNAVAILABLE, transitPointId: waitingHere ? parcel.currentTransitPointId : blocked.fromTransitPointId, legId: blocked.id, details: `Route deactivated for ${network.point(blocked.fromTransitPointId)?.name} → ${network.point(blocked.toTransitPointId)?.name}. Re-plan the remaining journey when the parcel is at a station.` })).alert;
      }, TX_OPTIONS);
      results.flagged++;
      for (const assignmentId of released) await this.dispatch.afterRelease(assignmentId, 'ROUTE_UNAVAILABLE');
      await this.ctx.announceAlert(alert, parcel.trackingNumber);
      this.ctx.emit('parcelStatusUpdate', { parcelId, status: parcel.status, custody: parcel.custody, location: parcel.currentLocation }, { userIds: [parcel.senderId, parcel.recipientId], transitPointIds: [parcel.currentTransitPointId, ...legs.flatMap((leg) => [leg.fromTransitPointId, leg.toTransitPointId])] });
    }
    return results;
  }

  /** Cancellation: a customer before hand-over, or staff while a station (or nobody known) holds the parcel. */
  async cancelParcel(parcelId: string, actor: Actor, reason: string) {
    const parcel = await this.prisma.parcel.findFirst({ where: { id: parcelId, deletedAt: null } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    if (parcel.status === ParcelStatus.cancelled) return parcel;
    if (actor.role === UserRole.CUSTOMER) {
      if (parcel.senderId !== actor.id) throw new NotFoundException('Parcel not found');
      if (parcel.status !== ParcelStatus.awaiting_confirmation) throw new BadRequestException('A parcel can only be cancelled online before it is handed over at the origin station; ask the station after that.');
    } else {
      await this.ctx.assertStation(actor, parcel.currentTransitPointId ?? parcel.originTransitPointId);
      const custody: CustodyHolder[] = [CustodyHolder.SENDER, CustodyHolder.STATION, CustodyHolder.UNKNOWN];
      if (!custody.includes(parcel.custody) || CLOSED_PARCEL.includes(parcel.status)) throw new BadRequestException('Only parcels held by a station (or not yet handed over) can be cancelled; a parcel with a driver must first be received at a station.');
    }
    const cancelled = await this.prisma.$transaction(async (tx) => {
      await this.ctx.lock(tx, 'parcels', parcelId);
      const updated = await tx.parcel.updateMany({ where: { id: parcelId, status: { notIn: [...CLOSED_PARCEL, ParcelStatus.cancelled] }, custody: { notIn: [CustodyHolder.DRIVER, CustodyHolder.HANDOVER, CustodyHolder.LOCKER] } }, data: { status: ParcelStatus.cancelled, completedAt: new Date(), completedBy: actor.id } });
      if (!updated.count) throw new ConflictException('The parcel changed while cancelling; refresh and try again.');
      const open = await tx.parcelAssignment.findMany({ where: { parcelId, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] } } });
      for (const offer of open) await this.dispatch.releaseOffer(tx, offer, 'PARCEL_CANCELLED', actor.id);
      await tx.parcelLeg.updateMany({ where: { parcelId, status: { notIn: TERMINAL_LEG } }, data: { status: ParcelLegStatus.CANCELLED } });
      await this.collection.releaseLockers(tx, parcelId, actor.id);
      await tx.tamperAlert.updateMany({ where: { parcelId, status: { not: AlertStatus.RESOLVED } }, data: { status: AlertStatus.RESOLVED, outcome: 'Parcel cancelled', resolvedAt: new Date(), resolvedBy: actor.id } });
      await this.ctx.history(tx, { parcelId, status: ParcelStatus.cancelled, location: parcel.currentLocation, updatedBy: actor.id, notes: `Parcel cancelled${reason ? `: ${reason}` : ''}. Driver offers and locker holds released.` });
      await this.ctx.audit(tx, { userId: actor.id, action: 'PARCEL_CANCELLED', entityType: 'Parcel', entityId: parcelId, after: { reason, actorRole: actor.role } });
      return tx.parcel.findUniqueOrThrow({ where: { id: parcelId } });
    }, TX_OPTIONS);
    await this.ctx.notifyParties(cancelled, { title: 'Parcel cancelled', message: `${cancelled.trackingNumber} was cancelled.`, type: NotificationType.PARCEL_IN_TRANSIT });
    this.ctx.emit('parcelStatusUpdate', { parcelId, status: ParcelStatus.cancelled }, { userIds: [cancelled.senderId, cancelled.recipientId], transitPointIds: [cancelled.currentTransitPointId] });
    return cancelled;
  }

  /** Staff correct the recorded weight after confirmation; any uncollected offer is re-evaluated. */
  async correctWeight(parcelId: string, weight: number, reason: string, actor: Actor) {
    if (!(weight > 0) || weight > 1000) throw new BadRequestException('Weight must be between 0 and 1000 kg');
    if (!reason?.trim() || reason.trim().length < 5) throw new BadRequestException('A reason of at least 5 characters is required to correct the weight');
    const parcel = await this.prisma.parcel.findFirst({ where: { id: parcelId, deletedAt: null } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    await this.ctx.assertStation(actor, parcel.currentTransitPointId);
    if (parcel.custody !== CustodyHolder.STATION) throw new ConflictException('The weight can only be corrected while a station holds the parcel');
    const legIds = await this.prisma.$transaction(async (tx) => {
      await this.ctx.lock(tx, 'parcels', parcelId);
      await tx.parcel.update({ where: { id: parcelId }, data: { weight } });
      const open = await tx.parcelAssignment.findMany({ where: { parcelId, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED] } } });
      for (const offer of open) await this.dispatch.releaseOffer(tx, offer, 'WEIGHT_CORRECTED', actor.id);
      await this.ctx.history(tx, { parcelId, status: parcel.status, location: parcel.currentLocation, updatedBy: actor.id, notes: `Weight corrected from ${parcel.weight} kg to ${weight} kg: ${reason.trim()}` });
      await this.ctx.audit(tx, { userId: actor.id, action: 'PARCEL_WEIGHT_CORRECTED', entityType: 'Parcel', entityId: parcelId, after: { from: parcel.weight, to: weight, reason } });
      return open.map((offer) => offer.legId);
    }, TX_OPTIONS);
    await this.dispatch.reassign(legIds);
    return this.prisma.parcel.findUniqueOrThrow({ where: { id: parcelId } });
  }

  /**
   * Resolving an exception. CONTINUE resumes the journey from the alert's station (the parcel is
   * physically there), CANCEL_PARCEL closes it, REPLAN re-plans from the station.
   */
  async resolveException(alertId: string, actor: Actor, data: { status: AlertStatus; investigation?: string; outcome?: string; action?: 'CONTINUE' | 'CANCEL_PARCEL' | 'REPLAN' }) {
    const alert = await this.prisma.tamperAlert.findUnique({ where: { id: alertId } });
    if (!alert) throw new NotFoundException('Alert not found');
    if (actor.role !== UserRole.ADMIN) {
      if (!alert.transitPointId) throw new NotFoundException('Alert not found');
      await this.ctx.assertStation(actor, alert.transitPointId, 'Alert not found');
    }
    if (!Object.values(AlertStatus).includes(data.status)) throw new BadRequestException('Choose a valid alert status');
    if (alert.status === AlertStatus.RESOLVED) return alert;
    if (data.status !== AlertStatus.RESOLVED) {
      return this.prisma.tamperAlert.update({ where: { id: alertId }, data: { status: data.status, investigation: data.investigation, outcome: data.outcome } });
    }
    const action = data.action ?? 'CONTINUE';
    const close = () => this.prisma.tamperAlert.update({ where: { id: alertId }, data: { status: AlertStatus.RESOLVED, investigation: data.investigation, outcome: data.outcome ?? action, resolvedBy: actor.id, resolvedAt: new Date() } });
    const parcel = await this.prisma.parcel.findUniqueOrThrow({ where: { id: alert.parcelId } });

    if (action === 'CANCEL_PARCEL') {
      if (parcel.custody === CustodyHolder.DRIVER || parcel.custody === CustodyHolder.HANDOVER) throw new ConflictException('Receive the parcel at a station before cancelling it');
      await this.cancelParcel(parcel.id, { ...actor, role: actor.role === UserRole.CUSTOMER ? UserRole.ADMIN : actor.role }, data.outcome ?? `Exception ${alert.type} resolved by cancelling`);
      return this.prisma.tamperAlert.findUniqueOrThrow({ where: { id: alertId } });
    }
    if (action === 'REPLAN') {
      // Re-plan first: if it is refused (no route yet, parcel not at a station) the exception stays open.
      const { settlement } = await this.replan(parcel.id, actor, { reason: data.outcome ?? `Exception ${alert.type} resolved by re-planning` });
      if (settlement.kind !== 'ROUTE_BLOCKED') await close();
      return this.prisma.tamperAlert.findUniqueOrThrow({ where: { id: alertId } });
    }

    const holdTypes: TamperAlertType[] = [
      TamperAlertType.PARCEL_DAMAGED, TamperAlertType.PARCEL_MISSING, TamperAlertType.UNEXPECTED_PARCEL, TamperAlertType.SEAL_BROKEN,
      TamperAlertType.SEAL_DAMAGED, TamperAlertType.QR_MISMATCH, TamperAlertType.DUPLICATE_QR,
    ];
    const held = parcel.status === ParcelStatus.tampering_alert || alert.type === TamperAlertType.UNEXPECTED_PARCEL;
    if (!holdTypes.includes(alert.type) || !held) return close();

    const stationId = alert.transitPointId ?? parcel.currentTransitPointId;
    if (!stationId) throw new BadRequestException('This exception has no station; resolve it with CANCEL_PARCEL or re-plan after receiving the parcel');
    const otherOpen = await this.prisma.tamperAlert.count({ where: { parcelId: parcel.id, id: { not: alertId }, status: { not: AlertStatus.RESOLVED }, type: { in: holdTypes } } });
    await close();
    if (otherOpen) return this.prisma.tamperAlert.findUniqueOrThrow({ where: { id: alertId } });
    const network = await this.ctx.network();
    const settlement = await this.prisma.$transaction(async (tx) => {
      await this.ctx.lock(tx, 'parcels', parcel.id);
      return this.settleAtStation(tx, network, { parcelId: parcel.id, stationId, actorId: actor.id, reason: `exception ${alert.type.replaceAll('_', ' ').toLowerCase()} resolved${data.outcome ? `: ${data.outcome}` : ''}` });
    }, TX_OPTIONS);
    await this.afterSettlement(settlement);
    return this.prisma.tamperAlert.findUniqueOrThrow({ where: { id: alertId } });
  }

  /**
   * Stop-by-stop journey for tracking screens, in customer language. Staff also get the internal leg,
   * assignment and trip details.
   */
  async journeyView(parcelId: string, audience: 'customer' | 'staff' | 'public' = 'customer') {
    const parcel = await this.prisma.parcel.findUniqueOrThrow({ where: { id: parcelId } });
    const network = await this.ctx.network();
    const legs = await this.prisma.parcelLeg.findMany({ where: { parcelId }, orderBy: { sequence: 'asc' }, include: { assignments: { orderBy: { assignedAt: 'asc' } } } });
    const tripIds = [...new Set(legs.flatMap((leg) => leg.assignments.map((item) => item.tripId)).filter((id): id is string => !!id))];
    const trips = tripIds.length ? await this.prisma.trip.findMany({ where: { id: { in: tripIds } } }) : [];
    const driverIds = [...new Set(legs.flatMap((leg) => leg.assignments.map((item) => item.driverId)))];
    const drivers = driverIds.length && audience === 'staff' ? await this.prisma.user.findMany({ where: { id: { in: driverIds } }, select: { id: true, name: true, phone: true, vehicleNumber: true } }) : [];
    const locker = await this.prisma.lockerAssignment.findFirst({ where: { parcelId }, orderBy: { assignedAt: 'desc' } });
    const compartment = locker ? await this.prisma.lockerCompartment.findUnique({ where: { id: locker.compartmentId } }) : null;
    const lockerStation = compartment ? await this.prisma.lockerStation.findUnique({ where: { id: compartment.stationId } }) : null;

    let effective = legs.filter((leg) => leg.status !== ParcelLegStatus.CANCELLED || !!leg.collectedAt);
    let planned = false;
    if (!effective.length && parcel.originTransitPointId && parcel.destinationTransitPointId && parcel.status === ParcelStatus.awaiting_confirmation) {
      const preview = network.plan(parcel.originTransitPointId, parcel.destinationTransitPointId);
      planned = !!preview?.length;
      effective = (preview ?? []).map((leg) => ({ id: `preview-${leg.sequence}`, parcelId, sequence: leg.sequence, routeId: leg.routeId, direction: leg.direction, fromTransitPointId: leg.fromTransitPointId, toTransitPointId: leg.toTransitPointId, isFinal: leg.sequence === preview!.length, status: ParcelLegStatus.PLANNED, assignments: [] } as any));
    }

    type StopView = { transitPointId: string; name: string; role: 'ORIGIN' | 'PASS' | 'TRANSFER' | 'DESTINATION'; state: 'DONE' | 'CURRENT' | 'PENDING'; events: { label: string; at: Date | null }[] };
    const stops: StopView[] = [];
    const fmtEvent = (label: string, at?: Date | null) => ({ label, at: at ?? null });
    effective.forEach((leg, legIndex) => {
      const nextLeg = effective[legIndex + 1];
      let ids = network.stops(leg.routeId, leg.direction).map((stop) => stop.transitPointId);
      const from = ids.indexOf(leg.fromTransitPointId);
      const to = ids.indexOf(leg.toTransitPointId);
      ids = from >= 0 && to > from ? ids.slice(from, to + 1) : [leg.fromTransitPointId, leg.toTransitPointId];
      if (leg.status === ParcelLegStatus.CANCELLED && nextLeg) {
        const cut = ids.indexOf(nextLeg.fromTransitPointId);
        if (cut >= 0) ids = ids.slice(0, cut + 1);
      }
      const carrying = leg.assignments.find((item: any) => item.status === AssignmentStatus.COLLECTED);
      const trip = carrying ? trips.find((item) => item.id === carrying.tripId) : undefined;
      const tripStops = trip ? network.stops(trip.routeId, trip.direction).map((stop) => stop.transitPointId) : [];
      const tripIndex = trip ? tripStops.indexOf(trip.currentTransitPointId ?? '') : -1;
      const legDone = ([ParcelLegStatus.AWAITING_VERIFICATION, ParcelLegStatus.COMPLETED, ParcelLegStatus.EXCEPTION] as ParcelLegStatus[]).includes(leg.status) || (leg.status === ParcelLegStatus.CANCELLED && !!leg.collectedAt);
      ids.forEach((id, position) => {
        if (position === 0 && legIndex > 0) return; // transfer station already listed as the previous leg's end
        const name = network.point(id)?.name ?? 'Station';
        const isFirst = legIndex === 0 && position === 0;
        const isLast = position === ids.length - 1;
        const role: StopView['role'] = isFirst ? 'ORIGIN' : isLast ? (leg.isFinal && legIndex === effective.length - 1 ? 'DESTINATION' : 'TRANSFER') : 'PASS';
        const events: StopView['events'] = [];
        let state: StopView['state'] = 'PENDING';
        if (isFirst) {
          if (parcel.originConfirmedAt) events.push(fmtEvent('Parcel received at station', parcel.originConfirmedAt));
          if (leg.collectedAt) events.push(fmtEvent('Driver collected', leg.collectedAt));
          state = leg.collectedAt ? 'DONE' : parcel.originConfirmedAt ? 'CURRENT' : 'PENDING';
        } else if (!isLast) {
          const tripPos = tripStops.indexOf(id);
          const passed = legDone || (trip && tripIndex >= 0 && tripPos >= 0 && (tripPos < tripIndex || (tripPos === tripIndex && !trip.atStop && trip.status === TripStatus.IN_TRANSIT)));
          const here = !legDone && trip && tripPos === tripIndex && trip.atStop;
          if (passed) { events.push(fmtEvent('Passed')); state = 'DONE'; } else if (here) { events.push(fmtEvent('Vehicle at this station')); state = 'CURRENT'; }
        } else {
          if (leg.droppedAt) events.push(fmtEvent('Arrived', leg.droppedAt));
          if (leg.status === ParcelLegStatus.COMPLETED) events.push(fmtEvent('Verified at station', leg.completedAt));
          if (leg.status === ParcelLegStatus.EXCEPTION) events.push(fmtEvent('Under review at station', leg.droppedAt));
          if (role === 'TRANSFER' && nextLeg) {
            const offer = nextLeg.assignments.find((item: any) => item.status !== AssignmentStatus.REJECTED && item.status !== AssignmentStatus.EXPIRED && item.status !== AssignmentStatus.CANCELLED);
            if (offer) events.push(fmtEvent('Connecting route assigned', offer.assignedAt));
            if (nextLeg.collectedAt) events.push(fmtEvent('Connecting driver collected', nextLeg.collectedAt));
            state = nextLeg.collectedAt ? 'DONE' : leg.droppedAt ? 'CURRENT' : 'PENDING';
          } else if (role === 'DESTINATION') {
            if (parcel.readyForCollectionAt) events.push(fmtEvent(parcel.deliveryMethod === 'SMART_LOCKER' && locker ? 'Destination reached' : 'Ready for collection', parcel.readyForCollectionAt));
            if (locker?.placedAt && lockerStation) events.push(fmtEvent(`In smart locker ${compartment?.compartmentNo}`, locker.placedAt));
            if (parcel.actualDeliveryTime && (parcel.status === ParcelStatus.delivered || parcel.status === ParcelStatus.completed)) events.push(fmtEvent('Delivered', parcel.actualDeliveryTime));
            state = parcel.status === ParcelStatus.delivered || parcel.status === ParcelStatus.completed ? 'DONE' : leg.droppedAt ? 'CURRENT' : 'PENDING';
          } else if (leg.status === ParcelLegStatus.CANCELLED) {
            state = 'DONE';
          }
        }
        stops.push({ transitPointId: id, name, role, state, events });
      });
    });

    const currentLeg = legs.find((leg) => !TERMINAL_LEG.includes(leg.status));
    const view: any = {
      parcelId: parcel.id,
      trackingNumber: parcel.trackingNumber,
      status: parcel.status,
      statusLabel: this.statusLabel(parcel, currentLeg),
      custody: parcel.custody,
      custodyLabel: this.custodyLabel(parcel.custody, parcel.currentLocation),
      planned,
      origin: parcel.originTransitPointId ? network.point(parcel.originTransitPointId)?.name ?? parcel.pickupAddress : parcel.pickupAddress,
      destination: parcel.destinationTransitPointId ? network.point(parcel.destinationTransitPointId)?.name ?? parcel.deliveryAddress : parcel.deliveryAddress,
      collectionMethod: parcel.deliveryMethod,
      collection: {
        readyAt: parcel.readyForCollectionAt, deadline: parcel.collectionDeadlineAt,
        overdue: !!parcel.collectionDeadlineAt && parcel.collectionDeadlineAt < new Date() && parcel.status === ParcelStatus.at_destination,
        locker: locker && !locker.cancelledAt && lockerStation ? { station: lockerStation.name, compartmentNo: compartment?.compartmentNo, placed: !!locker.placedAt, collectedAt: locker.collectedAt } : null,
      },
      legs: effective.map((leg) => ({
        sequence: leg.sequence,
        route: network.route(leg.routeId)?.name ?? 'Route',
        from: network.point(leg.fromTransitPointId)?.name,
        to: network.point(leg.toTransitPointId)?.name,
        label: this.legLabel(leg.status),
      })),
      stops,
    };
    if (audience === 'staff') {
      view.internal = {
        legs: legs.map((leg) => ({
          id: leg.id, sequence: leg.sequence, routeId: leg.routeId, route: network.route(leg.routeId)?.name, direction: leg.direction,
          fromTransitPointId: leg.fromTransitPointId, from: network.point(leg.fromTransitPointId)?.name,
          toTransitPointId: leg.toTransitPointId, to: network.point(leg.toTransitPointId)?.name,
          status: leg.status, isFinal: leg.isFinal, noDriverReason: leg.noDriverReason, activatedAt: leg.activatedAt, collectedAt: leg.collectedAt, droppedAt: leg.droppedAt, completedAt: leg.completedAt,
          assignments: leg.assignments.map((item) => ({
            id: item.id, status: item.status, driverId: item.driverId, driver: drivers.find((driver) => driver.id === item.driverId) ?? null, tripId: item.tripId,
            tripNumber: trips.find((trip) => trip.id === item.tripId)?.tripNumber ?? null, assignedAt: item.assignedAt, acceptanceDeadline: item.acceptanceDeadline, acceptedAt: item.acceptedAt,
            collectedAt: item.collectedAt, droppedAt: item.droppedAt, rejectedAt: item.rejectedAt, rejectionReason: item.rejectionReason, expiredAt: item.expiredAt,
            cancelledAt: item.cancelledAt, cancelledBy: item.cancelledBy, cancellationReason: item.cancellationReason, reservedWeightKg: item.reservedWeightKg,
          })),
        })),
        currentTransitPointId: parcel.currentTransitPointId,
      };
    }
    return view;
  }

  statusLabel(parcel: Pick<Parcel, 'status'>, currentLeg?: Pick<ParcelLeg, 'status' | 'sequence'> | null): string {
    switch (parcel.status) {
      case ParcelStatus.awaiting_confirmation: return 'Awaiting drop-off at origin station';
      case ParcelStatus.at_origin_transit_point: return currentLeg?.status === ParcelLegStatus.DRIVER_ASSIGNED ? 'At origin station – driver assigned' : 'At origin station – arranging a driver';
      case ParcelStatus.collected: return 'Collected by driver';
      case ParcelStatus.in_transit: return (currentLeg?.sequence ?? 1) > 1 ? 'In transit on connecting route' : 'In transit';
      case ParcelStatus.arrived_at_transit_point: return 'Arrived at station – being checked in';
      case ParcelStatus.at_transit_point: return currentLeg?.status === ParcelLegStatus.DRIVER_ASSIGNED ? 'At transfer station – connecting driver assigned' : 'At transfer station – waiting for connecting route';
      case ParcelStatus.at_destination: return 'Ready for collection';
      case ParcelStatus.locker_assigned: return 'Being placed in a smart locker';
      case ParcelStatus.in_locker: return 'In smart locker';
      case ParcelStatus.delivered:
      case ParcelStatus.completed: return 'Delivered';
      case ParcelStatus.tampering_alert: return 'Delayed – under review';
      case ParcelStatus.cancelled: return 'Cancelled';
      case ParcelStatus.returned: return 'Returned';
      default: return parcel.status.replaceAll('_', ' ');
    }
  }

  private custodyLabel(custody: CustodyHolder, location: string | null): string {
    switch (custody) {
      case CustodyHolder.SENDER: return 'With the sender';
      case CustodyHolder.STATION: return `At ${location ?? 'the station'}`;
      case CustodyHolder.DRIVER: return 'With the driver';
      case CustodyHolder.HANDOVER: return `Being handed over at ${location ?? 'the station'}`;
      case CustodyHolder.LOCKER: return `In ${location ?? 'a smart locker'}`;
      case CustodyHolder.RECIPIENT: return 'With the recipient';
      default: return 'Being located';
    }
  }

  private legLabel(status: ParcelLegStatus): string {
    const labels: Record<ParcelLegStatus, string> = {
      PLANNED: 'Upcoming', AWAITING_DRIVER: 'Arranging driver', DRIVER_ASSIGNED: 'Driver assigned', IN_TRANSIT: 'In transit',
      AWAITING_VERIFICATION: 'Arrived – checking in', COMPLETED: 'Completed', EXCEPTION: 'Under review', CANCELLED: 'Replaced',
    };
    return labels[status];
  }
}
