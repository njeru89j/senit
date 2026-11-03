import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CustodyHolder, LockerSize, LockerStatus, NotificationType, Parcel, ParcelStatus, TamperAlertType, UserRole } from '@prisma/client';
import { randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import { MailerService } from '../../mailer/mailer.service';
import { Actor, SYSTEM_ACTOR, TX_OPTIONS, Tx, WorkflowContext } from './workflow-context.service';
import { STATION_COLLECTION_WINDOW_MS, formatDeadline } from './dispatch-rules';

export const SMART_LOCKER = 'SMART_LOCKER';
export const STATION_COLLECTION = 'STATION_COLLECTION';
export const COLLECTION_METHODS = [STATION_COLLECTION, SMART_LOCKER] as const;
const MAX_LOCKER_STAY_MINUTES = 72 * 60;
const DEFAULT_LOCKER_MINUTES = 24 * 60;
const SIZES: LockerSize[] = [LockerSize.SMALL, LockerSize.MEDIUM, LockerSize.LARGE, LockerSize.EXTRA_LARGE];

/** Smallest compartment size for a parcel weight (existing sizing policy). */
export function lockerSizeFor(weightKg: number): LockerSize {
  return weightKg <= 2 ? LockerSize.SMALL : weightKg <= 10 ? LockerSize.MEDIUM : weightKg <= 25 ? LockerSize.LARGE : LockerSize.EXTRA_LARGE;
}

type LockerTrigger = 'REQUESTED' | 'OVERDUE' | 'CUSTOMER_REQUEST' | 'STAFF';

/**
 * Final collection at the destination station: station collection with a 12-hour window, or a smart
 * locker. Locker compartments are reserved automatically and released to the customer (code sent) only
 * after an officer confirms the parcel is physically inside.
 */
@Injectable()
export class CollectionService {
  private readonly logger = new Logger(CollectionService.name);
  private readonly codeAttempts = new Map<string, { count: number; lockedUntil?: Date }>();

  constructor(private readonly ctx: WorkflowContext, private readonly mailer: MailerService) {}

  private get prisma() { return this.ctx.prisma; }

  private async email(parcel: Parcel, subject: string, details: { location: string; deadline: Date; locker?: string; collectionCode?: string }) {
    try {
      await this.mailer.sendGenericEmail({
        to: parcel.recipientEmail,
        subject,
        template: 'parcel-ready-for-collection',
        context: {
          name: parcel.recipientName, parcelId: parcel.id, trackingNumber: parcel.trackingNumber, location: details.location,
          deadline: details.deadline.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }), locker: details.locker, collectionCode: details.collectionCode,
        },
      });
    } catch (error) {
      this.logger.warn(`Collection email for ${parcel.trackingNumber} failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Inside the verification transaction: the parcel is now in destination-station custody with a 12-hour window. */
  async markReadyAtStation(tx: Tx, parcel: Parcel, stationId: string, actorId: string, now = new Date()) {
    const station = await this.ctx.pointName(stationId, tx);
    const deadline = new Date(now.getTime() + STATION_COLLECTION_WINDOW_MS);
    await tx.parcel.update({
      where: { id: parcel.id },
      data: { status: ParcelStatus.at_destination, custody: CustodyHolder.STATION, currentTransitPointId: stationId, currentLocation: station, readyForCollectionAt: now, collectionDeadlineAt: deadline, collectionOverdueAlertedAt: null, driverId: parcel.driverId },
    });
    await this.ctx.history(tx, { parcelId: parcel.id, status: ParcelStatus.at_destination, location: station, updatedBy: actorId, notes: `Destination reached and verified at ${station}. Ready for collection until ${formatDeadline(deadline)}.` });
  }

  /** After final verification: automatic locker when requested, otherwise (or when full) station collection. */
  async startFinalCollection(parcelId: string): Promise<void> {
    const parcel = await this.prisma.parcel.findUnique({ where: { id: parcelId } });
    if (!parcel || parcel.status !== ParcelStatus.at_destination) return;
    const station = await this.ctx.pointName(parcel.currentTransitPointId);
    const deadline = parcel.collectionDeadlineAt ?? new Date(Date.now() + STATION_COLLECTION_WINDOW_MS);
    const until = deadline.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
    if (parcel.deliveryMethod === SMART_LOCKER) {
      const reserved = await this.tryAutoLocker(parcel.id, 'REQUESTED');
      if (reserved) return;
      await this.prisma.$transaction(async (tx) => {
        const open = await tx.lockerRequest.updateMany({ where: { parcelId, status: 'PENDING' }, data: { status: 'UNAVAILABLE', reviewedAt: new Date() } });
        if (!open.count && !(await tx.lockerRequest.findFirst({ where: { parcelId, status: 'UNAVAILABLE' } }))) {
          await tx.lockerRequest.create({ data: { parcelId, requestedBy: parcel.recipientId ?? parcel.senderId ?? SYSTEM_ACTOR, size: lockerSizeFor(parcel.weight), status: 'UNAVAILABLE', reviewedAt: new Date() } });
        }
        await this.ctx.history(tx, { parcelId, status: parcel.status, location: station, notes: 'Smart locker requested but no suitable locker was free; the parcel is available for station collection instead.' });
      }, TX_OPTIONS);
      await this.ctx.notifyParties(parcel, { title: 'Ready for station collection', message: `No smart locker was free at ${station}, so ${parcel.trackingNumber} is ready for collection at the station counter until ${until}.`, type: NotificationType.PARCEL_READY_FOR_COLLECTION });
    } else {
      await this.ctx.notifyParties(parcel, { title: 'Ready for collection', message: `${parcel.trackingNumber} is ready at ${station}. Collect it before ${until}.`, type: NotificationType.PARCEL_READY_FOR_COLLECTION });
    }
    await this.email(parcel, `Parcel ${parcel.trackingNumber} is ready for collection`, { location: station, deadline });
    this.ctx.emit('parcelStatusUpdate', { parcelId, status: parcel.status, location: station }, { userIds: [parcel.senderId, parcel.recipientId], transitPointIds: [parcel.currentTransitPointId] });
  }

  /**
   * Reserves a free compartment at the parcel's station. The compartment is claimed with a conditional
   * update under SKIP LOCKED so two parcels never share one. Returns null when none fits.
   */
  async tryAutoLocker(parcelId: string, trigger: LockerTrigger, assignedBy = SYSTEM_ACTOR) {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.ctx.lock(tx, 'parcels', parcelId);
      const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: parcelId } });
      if (parcel.status !== ParcelStatus.at_destination || parcel.custody !== CustodyHolder.STATION || !parcel.currentTransitPointId) return null;
      if (await tx.lockerAssignment.findFirst({ where: { parcelId, collectedAt: null, cancelledAt: null } })) return null;
      // A locker that already expired sends the parcel back to the counter for good: no automatic loop.
      if (trigger !== 'STAFF' && await tx.lockerAssignment.findFirst({ where: { parcelId, endedReason: 'EXPIRED' } })) return null;
      const stations = await tx.lockerStation.findMany({ where: { transitPointId: parcel.currentTransitPointId, active: true }, orderBy: { name: 'asc' } });
      if (!stations.length) return null;
      const fits = SIZES.slice(SIZES.indexOf(lockerSizeFor(parcel.weight)));
      for (const size of fits) {
        for (const station of stations) {
          const claimed = await tx.$queryRaw<{ id: string; compartmentNo: string }[]>`
            UPDATE "locker_compartments" SET "status" = 'RESERVED', "currentParcelId" = ${parcelId}
            WHERE "id" = (
              SELECT "id" FROM "locker_compartments"
              WHERE "stationId" = ${station.id} AND "size"::text = ${size} AND "status" = 'AVAILABLE'
              ORDER BY "compartmentNo" LIMIT 1 FOR UPDATE SKIP LOCKED
            ) RETURNING "id", "compartmentNo"`;
          if (!claimed.length) continue;
          const assignment = await tx.lockerAssignment.create({ data: { parcelId, compartmentId: claimed[0].id, assignedBy } });
          await tx.parcel.update({ where: { id: parcelId }, data: { status: ParcelStatus.locker_assigned } });
          await tx.lockerRequest.updateMany({ where: { parcelId, status: { in: ['PENDING', 'UNAVAILABLE'] } }, data: { status: 'RESERVED', stationId: station.id, reviewedAt: new Date() } });
          const why = trigger === 'OVERDUE' ? ' after the 12-hour station collection window ended' : trigger === 'CUSTOMER_REQUEST' ? ' at the customer\'s request' : '';
          await this.ctx.history(tx, { parcelId, status: ParcelStatus.locker_assigned, location: parcel.currentLocation, updatedBy: assignedBy, notes: `Smart locker ${claimed[0].compartmentNo} at ${station.name} reserved${why}; staff will place the parcel and the collection code will then be sent.` });
          await this.ctx.audit(tx, { userId: assignedBy, action: 'LOCKER_RESERVED', entityType: 'LockerAssignment', entityId: assignment.id, after: { parcelId, trigger, compartmentId: claimed[0].id } });
          return { assignment, parcel, station, compartmentNo: claimed[0].compartmentNo, size };
        }
      }
      return null;
    }, TX_OPTIONS);
    if (!result) return null;
    await this.ctx.notifyStation([result.parcel.currentTransitPointId], {
      title: 'Place parcel in locker',
      message: `Put ${result.parcel.trackingNumber} into locker ${result.compartmentNo} (${result.station.name}) and confirm placement; the customer receives the code once it is placed.`,
      type: NotificationType.OFFICER_ACTION_REQUIRED, parcelId, actionUrl: '/transit-officer/dashboard',
    });
    await this.ctx.notifyParties(result.parcel, { title: 'Smart locker assigned', message: `${result.parcel.trackingNumber} has been assigned locker ${result.compartmentNo} at ${result.station.name}. The collection code will be sent as soon as staff place it inside.`, type: NotificationType.PARCEL_READY_FOR_COLLECTION });
    this.ctx.emit('stationWorkUpdate', { kind: 'LOCKER_PLACEMENT', parcelId, lockerAssignmentId: result.assignment.id }, { transitPointIds: [result.parcel.currentTransitPointId], userIds: [result.parcel.senderId, result.parcel.recipientId] });
    return result;
  }

  /** The officer has physically put the parcel in its reserved compartment: issue and send the code. */
  async confirmPlaced(lockerAssignmentId: string, actor: Actor) {
    const assignment = await this.prisma.lockerAssignment.findUnique({ where: { id: lockerAssignmentId } });
    if (!assignment || assignment.cancelledAt || assignment.collectedAt) throw new NotFoundException('Active locker reservation not found');
    const parcel = await this.prisma.parcel.findUniqueOrThrow({ where: { id: assignment.parcelId } });
    await this.ctx.assertStation(actor, parcel.currentTransitPointId, 'This locker is not at your assigned transit point');
    if (assignment.placedAt) return { message: 'Parcel already placed in the locker.', lockerAssignmentId };
    const request = await this.prisma.lockerRequest.findFirst({ where: { parcelId: parcel.id }, orderBy: { createdAt: 'desc' } });
    const minutes = Math.min(MAX_LOCKER_STAY_MINUTES, Math.max(60, request?.requestedMinutes ?? DEFAULT_LOCKER_MINUTES));
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + minutes * 60_000);
    const placed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.lockerAssignment.updateMany({ where: { id: lockerAssignmentId, placedAt: null, cancelledAt: null, collectedAt: null }, data: { placedAt: new Date() } });
      if (!updated.count) return null;
      const compartment = await tx.lockerCompartment.update({ where: { id: assignment.compartmentId }, data: { status: LockerStatus.AWAITING_COLLECTION, currentParcelId: parcel.id } });
      const station = await tx.lockerStation.findUniqueOrThrow({ where: { id: compartment.stationId } });
      await tx.collectionCode.create({ data: { lockerAssignmentId, codeHash: await bcrypt.hash(code, 10), expiresAt } });
      const location = `${station.name} locker ${compartment.compartmentNo}`;
      await tx.parcel.update({ where: { id: parcel.id }, data: { status: ParcelStatus.in_locker, custody: CustodyHolder.LOCKER, currentLocation: location } });
      await tx.lockerRequest.updateMany({ where: { parcelId: parcel.id, status: 'RESERVED' }, data: { status: 'APPROVED', reviewedBy: actor.id, reviewedAt: new Date() } });
      await this.ctx.history(tx, { parcelId: parcel.id, status: ParcelStatus.in_locker, location, updatedBy: actor.id, notes: `Parcel placed in locker ${compartment.compartmentNo}; collection code sent to the recipient (valid until ${formatDeadline(expiresAt)}).` });
      await this.ctx.resolveAlerts(tx, parcel.id, [TamperAlertType.COLLECTION_OVERDUE], 'Placed in a smart locker', actor.id);
      await this.ctx.audit(tx, { userId: actor.id, action: 'LOCKER_PLACED', entityType: 'LockerAssignment', entityId: lockerAssignmentId });
      return { station, compartment };
    }, TX_OPTIONS);
    if (!placed) return { message: 'Parcel already placed in the locker.', lockerAssignmentId };
    await this.sendCode(parcel, placed.station.name, placed.compartment.compartmentNo, code, expiresAt);
    this.ctx.emit('parcelStatusUpdate', { parcelId: parcel.id, status: ParcelStatus.in_locker }, { userIds: [parcel.senderId, parcel.recipientId], transitPointIds: [parcel.currentTransitPointId] });
    return { message: `${parcel.trackingNumber} is in locker ${placed.compartment.compartmentNo}; the code was sent to the recipient.`, lockerAssignmentId, compartmentNo: placed.compartment.compartmentNo, expiresAt };
  }

  /** The code goes to the recipient only; the sender is told the parcel is ready. */
  private async sendCode(parcel: Parcel, stationName: string, compartmentNo: string, code: string, expiresAt: Date) {
    const until = expiresAt.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
    await this.ctx.notifyUsers([parcel.recipientId], { title: 'Smart locker collection code', message: `${parcel.trackingNumber} is in locker ${compartmentNo} at ${stationName}. Use code ${code} before ${until}.`, type: NotificationType.PARCEL_READY_FOR_COLLECTION, parcelId: parcel.id, actionUrl: `/parcels/${parcel.id}` });
    if (parcel.senderId !== parcel.recipientId) await this.ctx.notifyUsers([parcel.senderId], { title: 'Parcel in smart locker', message: `${parcel.trackingNumber} is in a smart locker at ${stationName}, ready for the recipient.`, type: NotificationType.PARCEL_READY_FOR_COLLECTION, parcelId: parcel.id, actionUrl: `/parcels/${parcel.id}` });
    await this.email(parcel, `Parcel ${parcel.trackingNumber} is in your locker`, { location: stationName, locker: compartmentNo, collectionCode: code, deadline: expiresAt });
  }

  /** Staff exception control: put a verified parcel into a chosen station's locker straight away. */
  async assignLockerManually(data: { parcelId: string; stationId?: string }, actor: Actor) {
    const parcel = await this.prisma.parcel.findFirst({ where: { id: data.parcelId, deletedAt: null } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    await this.ctx.assertStation(actor, parcel.currentTransitPointId, 'Parcel not found at your assigned transit point');
    if (parcel.status !== ParcelStatus.at_destination) throw new BadRequestException('Only a parcel verified at its destination and waiting at the station can go into a locker');
    const reserved = await this.tryAutoLocker(parcel.id, 'STAFF', actor.id);
    if (!reserved) throw new ConflictException('No suitable locker is free at this station');
    return this.confirmPlaced(reserved.assignment.id, actor);
  }

  /** A customer asks for a locker while the parcel waits at the destination counter. */
  async requestLocker(data: { parcelId: string; requestedMinutes?: number }, customerId: string) {
    const parcel = await this.prisma.parcel.findFirst({ where: { id: data.parcelId, deletedAt: null, OR: [{ recipientId: customerId }, { senderId: customerId }] } });
    if (!parcel) throw new NotFoundException('Parcel not found');
    const minutes = data.requestedMinutes ?? DEFAULT_LOCKER_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 60 || minutes > MAX_LOCKER_STAY_MINUTES) throw new BadRequestException('Locker holding time must be between 1 and 72 hours');
    if (parcel.status === ParcelStatus.in_locker || parcel.status === ParcelStatus.locker_assigned) throw new BadRequestException('This parcel already has a locker');
    if (parcel.status === ParcelStatus.awaiting_confirmation) {
      await this.prisma.parcel.update({ where: { id: parcel.id }, data: { deliveryMethod: SMART_LOCKER } });
    } else if (parcel.status !== ParcelStatus.at_destination) {
      if (['delivered', 'completed', 'cancelled', 'returned'].includes(parcel.status)) throw new BadRequestException('A locker cannot be requested for a closed parcel');
    }
    const open = await this.prisma.lockerRequest.findFirst({ where: { parcelId: parcel.id, status: 'PENDING' } });
    const request = open ?? await this.prisma.lockerRequest.create({ data: { parcelId: parcel.id, requestedBy: customerId, size: lockerSizeFor(parcel.weight), requestedMinutes: minutes } });
    if (parcel.status !== ParcelStatus.at_destination) return { request, message: 'Locker requested. One will be assigned automatically when the parcel reaches its destination.' };
    const reserved = await this.tryAutoLocker(parcel.id, 'CUSTOMER_REQUEST');
    if (reserved) return { request, message: `Locker ${reserved.compartmentNo} reserved. The code will be sent once staff place the parcel inside.` };
    await this.prisma.lockerRequest.update({ where: { id: request.id }, data: { status: 'UNAVAILABLE', reviewedAt: new Date() } });
    return { request, message: 'No suitable locker is free right now; the parcel stays available at the station counter.' };
  }

  /** Completes locker collection with the recipient's code (registered user, assisting staff, or the kiosk). */
  async collectFromLocker(assignmentId: string, code: string, user?: Actor) {
    await this.expireLockerCodes();
    const attempt = this.codeAttempts.get(assignmentId);
    if (attempt?.lockedUntil && attempt.lockedUntil > new Date()) throw new BadRequestException('Too many invalid attempts. Try again later');
    const assignment = await this.prisma.lockerAssignment.findUnique({ where: { id: assignmentId } });
    if (!assignment || assignment.collectedAt || assignment.cancelledAt || !assignment.placedAt) throw new NotFoundException('Active locker assignment not found');
    const parcel = await this.prisma.parcel.findUniqueOrThrow({ where: { id: assignment.parcelId } });
    if (user?.role === UserRole.TRANSIT_OFFICER) await this.ctx.assertStation(user, parcel.currentTransitPointId, 'This locker is not at your assigned transit point');
    else if (user && user.role !== UserRole.ADMIN && parcel.senderId !== user.id && parcel.recipientId !== user.id) throw new NotFoundException('Locker assignment not found');
    const token = await this.prisma.collectionCode.findFirst({ where: { lockerAssignmentId: assignmentId, usedAt: null }, orderBy: { createdAt: 'desc' } });
    if (!token || token.expiresAt < new Date() || !code || !(await bcrypt.compare(String(code), token.codeHash))) {
      const count = (attempt?.count ?? 0) + 1;
      this.codeAttempts.set(assignmentId, { count, lockedUntil: count >= 5 ? new Date(Date.now() + 15 * 60_000) : undefined });
      await this.prisma.auditLog.create({ data: { userId: user?.id, action: 'LOCKER_CODE_REJECTED', entityType: 'LockerAssignment', entityId: assignmentId, after: { attempt: count, channel: user ? user.role : 'PUBLIC_KIOSK' } } });
      throw new BadRequestException('Invalid, expired, or already-used collection code');
    }
    const by = user?.role === UserRole.TRANSIT_OFFICER || user?.role === UserRole.ADMIN ? ` (assisted by ${user.role === UserRole.ADMIN ? 'admin' : 'transit officer'})` : user ? '' : ' at the locker kiosk';
    const done = await this.prisma.$transaction(async (tx) => {
      const used = await tx.collectionCode.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } });
      if (!used.count) return false;
      const now = new Date();
      await tx.lockerAssignment.update({ where: { id: assignmentId }, data: { collectedAt: now, endedReason: 'COLLECTED' } });
      await tx.lockerCompartment.update({ where: { id: assignment.compartmentId }, data: { status: LockerStatus.AVAILABLE, currentParcelId: null } });
      await tx.parcel.update({ where: { id: parcel.id }, data: { status: ParcelStatus.delivered, custody: CustodyHolder.RECIPIENT, actualDeliveryTime: now, deliveredToRecipient: true, deliveryConfirmedAt: now, deliveryConfirmedBy: user?.id ?? 'locker-code', currentTransitPointId: null } });
      await this.ctx.history(tx, { parcelId: parcel.id, status: ParcelStatus.delivered, location: parcel.currentLocation, updatedBy: user?.id, notes: `Collected from the smart locker with the collection code${by}. Delivered.` });
      await this.ctx.resolveAlerts(tx, parcel.id, [TamperAlertType.COLLECTION_OVERDUE], 'Collected by the recipient', user?.id);
      await this.ctx.audit(tx, { userId: user?.id, action: 'LOCKER_COLLECTION_COMPLETED', entityType: 'LockerAssignment', entityId: assignmentId, after: { parcelId: parcel.id, channel: user ? user.role : 'PUBLIC_KIOSK' } });
      return true;
    }, TX_OPTIONS);
    if (!done) throw new BadRequestException('Invalid, expired, or already-used collection code');
    this.codeAttempts.delete(assignmentId);
    await this.afterDelivered(parcel, 'from the smart locker');
    await this.fillFreedLocker(parcel.currentTransitPointId);
    return { collected: true, trackingNumber: parcel.trackingNumber };
  }

  async collectFromLockerByTracking(trackingNumber: string, code: string) {
    const parcel = await this.prisma.parcel.findFirst({ where: { trackingNumber: trackingNumber?.trim(), deletedAt: null, status: ParcelStatus.in_locker } });
    const assignment = parcel ? await this.prisma.lockerAssignment.findFirst({ where: { parcelId: parcel.id, collectedAt: null, cancelledAt: null } }) : null;
    if (!assignment) throw new BadRequestException('Invalid, expired, or already-used collection code');
    return this.collectFromLocker(assignment.id, code);
  }

  /**
   * Counter collection. A registered recipient confirms their own collection within the 12-hour window;
   * station staff hand over after checking the collector's identity (guests, or after the window).
   */
  async counterHandover(parcelId: string, user: Actor) {
    const parcel = await this.prisma.parcel.findFirst({ where: { id: parcelId, deletedAt: null } });
    if (!parcel || (user.role === UserRole.CUSTOMER && parcel.recipientId !== user.id)) throw new NotFoundException('Parcel is not available for collection');
    const staff = user.role === UserRole.ADMIN || user.role === UserRole.TRANSIT_OFFICER;
    if (staff) await this.ctx.assertStation(user, parcel.currentTransitPointId);
    if (parcel.status === ParcelStatus.delivered) return { message: 'Parcel already collected.', parcel };
    const allowed: ParcelStatus[] = staff ? [ParcelStatus.at_destination, ParcelStatus.locker_assigned] : [ParcelStatus.at_destination];
    if (!allowed.includes(parcel.status)) throw new BadRequestException('This parcel is not waiting at the station counter');
    const windowLapsed = !!parcel.collectionDeadlineAt && parcel.collectionDeadlineAt < new Date();
    if (windowLapsed && !staff) throw new BadRequestException('The 12-hour collection window has ended; collect it at the station counter with ID');
    const done = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.parcel.updateMany({ where: { id: parcelId, status: { in: allowed } }, data: { status: ParcelStatus.delivered, custody: CustodyHolder.RECIPIENT, actualDeliveryTime: now, deliveredToRecipient: true, deliveryConfirmedAt: now, deliveryConfirmedBy: user.id, currentTransitPointId: null } });
      if (!updated.count) return null;
      // A reserved-but-unplaced locker is released when the parcel leaves over the counter.
      const reservation = await tx.lockerAssignment.findFirst({ where: { parcelId, collectedAt: null, cancelledAt: null } });
      if (reservation) {
        await tx.lockerAssignment.update({ where: { id: reservation.id }, data: { cancelledAt: now, endedReason: 'COUNTER_HANDOVER' } });
        await tx.lockerCompartment.update({ where: { id: reservation.compartmentId }, data: { status: LockerStatus.AVAILABLE, currentParcelId: null } });
      }
      await this.ctx.history(tx, { parcelId, status: ParcelStatus.delivered, location: parcel.currentLocation, updatedBy: user.id, notes: staff ? `Handed to the recipient at the station counter after an identity check${windowLapsed ? ' (after the collection window)' : ''}. Delivered.` : 'Collected by the recipient at the station counter. Delivered.' });
      await this.ctx.resolveAlerts(tx, parcelId, [TamperAlertType.COLLECTION_OVERDUE], 'Collected by the recipient', user.id);
      await this.ctx.audit(tx, { userId: user.id, action: 'STATION_COLLECTION_COMPLETED', entityType: 'Parcel', entityId: parcelId, after: { actorRole: user.role, windowLapsed } });
      return { freedLocker: !!reservation };
    }, TX_OPTIONS);
    const delivered = await this.prisma.parcel.findUniqueOrThrow({ where: { id: parcelId } });
    if (!done) return { message: 'Parcel already collected.', parcel: delivered };
    await this.afterDelivered(delivered, 'at the station counter');
    if (done.freedLocker) await this.fillFreedLocker(parcel.currentTransitPointId);
    return { message: `${parcel.trackingNumber} handed over and delivered.`, parcel: delivered };
  }

  private async afterDelivered(parcel: Parcel, how: string) {
    await this.ctx.notifyParties(parcel, { title: 'Parcel delivered', message: `${parcel.trackingNumber} was collected ${how}.`, type: NotificationType.PARCEL_DELIVERED });
    this.ctx.emit('parcelStatusUpdate', { parcelId: parcel.id, status: ParcelStatus.delivered }, { userIds: [parcel.senderId, parcel.recipientId], transitPointIds: [parcel.currentTransitPointId] });
    await this.emailSenderCollected(parcel, how);
  }

  /** The sender is told, by email, as soon as the recipient has the parcel in hand. */
  private async emailSenderCollected(parcel: Parcel, how: string) {
    if (!parcel.senderEmail) return;
    const collectedAt = parcel.actualDeliveryTime ?? new Date();
    try {
      await this.mailer.sendGenericEmail({
        to: parcel.senderEmail,
        subject: `${parcel.recipientName} collected parcel ${parcel.trackingNumber}`,
        template: 'parcel-collected-sender',
        context: {
          name: parcel.senderName,
          trackingNumber: parcel.trackingNumber,
          recipientName: parcel.recipientName,
          how,
          location: parcel.currentLocation ?? parcel.deliveryAddress,
          collectedAt: formatDeadline(collectedAt),
        },
      });
    } catch (error) {
      this.logger.warn(`Collection notice to the sender of ${parcel.trackingNumber} failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** A compartment freed up: offer it to the longest-overdue parcel at that station. */
  async fillFreedLocker(transitPointId: string | null) {
    if (!transitPointId) return;
    const overdue = await this.prisma.parcel.findMany({ where: { currentTransitPointId: transitPointId, status: ParcelStatus.at_destination, collectionDeadlineAt: { lt: new Date() }, deletedAt: null }, orderBy: { collectionDeadlineAt: 'asc' }, take: 5, select: { id: true } });
    for (const parcel of overdue) if (await this.tryAutoLocker(parcel.id, 'OVERDUE')) return;
  }

  /**
   * Server-side collection sweep: pending locker requests, the 12-hour station window (automatic locker,
   * otherwise overdue in secure station custody with one officer alert), and overdue locker placements.
   */
  async collectionSweep(now = new Date()) {
    const pendingLocker = await this.prisma.parcel.findMany({ where: { status: ParcelStatus.at_destination, deliveryMethod: SMART_LOCKER, deletedAt: null, collectionDeadlineAt: { gt: now } }, select: { id: true }, take: 100 });
    for (const parcel of pendingLocker) {
      if (await this.prisma.lockerRequest.findFirst({ where: { parcelId: parcel.id, status: 'PENDING' } })) await this.startFinalCollection(parcel.id);
    }
    const overdue = await this.prisma.parcel.findMany({ where: { status: { in: [ParcelStatus.at_destination, ParcelStatus.locker_assigned] }, collectionDeadlineAt: { lt: now }, deletedAt: null }, orderBy: { collectionDeadlineAt: 'asc' }, take: 200 });
    let lockered = 0;
    let flagged = 0;
    for (const parcel of overdue) {
      if (parcel.status === ParcelStatus.at_destination) {
        const reserved = await this.tryAutoLocker(parcel.id, 'OVERDUE');
        if (reserved) { lockered++; continue; }
      }
      if (parcel.collectionOverdueAlertedAt) continue;
      const station = await this.ctx.pointName(parcel.currentTransitPointId);
      const details = parcel.status === ParcelStatus.locker_assigned
        ? `Locker reserved at ${station} but the parcel has not been placed and the collection window has ended.`
        : `Not collected within 12 hours at ${station} and no smart locker is free. Keep it in secure station custody; a locker is retried automatically.`;
      const alert = await this.prisma.$transaction(async (tx) => {
        const marked = await tx.parcel.updateMany({ where: { id: parcel.id, collectionOverdueAlertedAt: null }, data: { collectionOverdueAlertedAt: now } });
        if (!marked.count) return null;
        await this.ctx.history(tx, { parcelId: parcel.id, status: parcel.status, location: station, notes: `Collection overdue. ${details}` });
        return (await this.ctx.raiseAlert(tx, { parcelId: parcel.id, type: TamperAlertType.COLLECTION_OVERDUE, details, transitPointId: parcel.currentTransitPointId })).alert;
      }, TX_OPTIONS);
      if (alert) { flagged++; await this.ctx.announceAlert(alert, parcel.trackingNumber); }
    }
    return { lockered, flagged };
  }

  /** Expired locker codes: the parcel returns to station custody for counter collection (no automatic re-locker). */
  async expireLockerCodes(now = new Date()) {
    const expiredCodes = await this.prisma.collectionCode.findMany({ where: { usedAt: null, expiresAt: { lt: now } }, select: { lockerAssignmentId: true } });
    if (!expiredCodes.length) return { expired: 0 };
    const assignments = await this.prisma.lockerAssignment.findMany({ where: { id: { in: [...new Set(expiredCodes.map((code) => code.lockerAssignmentId))] }, collectedAt: null, cancelledAt: null } });
    let expired = 0;
    for (const assignment of assignments) {
      const result = await this.prisma.$transaction(async (tx) => {
        const ended = await tx.lockerAssignment.updateMany({ where: { id: assignment.id, collectedAt: null, cancelledAt: null }, data: { cancelledAt: now, endedReason: 'EXPIRED' } });
        if (!ended.count) return null;
        await tx.collectionCode.updateMany({ where: { lockerAssignmentId: assignment.id, usedAt: null }, data: { usedAt: now } });
        await tx.lockerCompartment.update({ where: { id: assignment.compartmentId }, data: { status: LockerStatus.AVAILABLE, currentParcelId: null } });
        const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: assignment.parcelId } });
        const location = await this.ctx.pointName(parcel.currentTransitPointId, tx);
        await tx.parcel.update({ where: { id: parcel.id }, data: { status: ParcelStatus.at_destination, custody: CustodyHolder.STATION, currentLocation: location, collectionOverdueAlertedAt: now } });
        await this.ctx.history(tx, { parcelId: parcel.id, status: ParcelStatus.at_destination, location, notes: 'Locker collection window expired. Staff must remove the parcel from the locker; it stays in station custody for counter collection with ID.' });
        const { alert } = await this.ctx.raiseAlert(tx, { parcelId: parcel.id, type: TamperAlertType.COLLECTION_OVERDUE, details: `Locker code expired at ${location}; remove the parcel from the locker and hold it for counter collection.`, transitPointId: parcel.currentTransitPointId });
        await this.ctx.audit(tx, { action: 'LOCKER_ASSIGNMENT_EXPIRED', entityType: 'LockerAssignment', entityId: assignment.id, after: { parcelId: parcel.id } });
        return { alert, parcel };
      }, TX_OPTIONS);
      if (result) { expired++; await this.ctx.announceAlert(result.alert, result.parcel.trackingNumber); }
    }
    return { expired };
  }

  /** Releases locker holds when a parcel is cancelled (inside the caller's transaction). */
  async releaseLockers(tx: Tx, parcelId: string, actorId: string) {
    const holds = await tx.lockerAssignment.findMany({ where: { parcelId, collectedAt: null, cancelledAt: null } });
    for (const hold of holds) {
      await tx.lockerAssignment.update({ where: { id: hold.id }, data: { cancelledAt: new Date(), endedReason: 'CANCELLED' } });
      await tx.collectionCode.updateMany({ where: { lockerAssignmentId: hold.id, usedAt: null }, data: { usedAt: new Date() } });
      await tx.lockerCompartment.update({ where: { id: hold.compartmentId }, data: { status: LockerStatus.AVAILABLE, currentParcelId: null } });
    }
    await tx.lockerRequest.updateMany({ where: { parcelId, status: { in: ['PENDING', 'RESERVED', 'UNAVAILABLE'] } }, data: { status: 'REJECTED', reviewedBy: actorId === SYSTEM_ACTOR ? null : actorId, reviewedAt: new Date() } });
  }
}
