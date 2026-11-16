import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, CustodyHolder, ParcelLegStatus, ParcelStatus, SealCondition, TamperAlertType, TripStatus } from '@prisma/client';
import { JourneyService, Settlement } from './journey.service';
import { Actor, TX_OPTIONS, WorkflowContext } from './workflow-context.service';

export const VERIFICATION_OUTCOMES = ['VERIFIED', 'MISSING', 'DAMAGED', 'TAMPER_ALERT'] as const;
export type VerificationOutcome = typeof VERIFICATION_OUTCOMES[number];
export type VerificationItem = { parcelId: string; outcome: VerificationOutcome; condition?: SealCondition; notes?: string };
export type VerificationResult = { parcelId: string; trackingNumber?: string; result: VerificationOutcome | 'UNEXPECTED' | 'ALREADY_VERIFIED' | 'ERROR'; message: string };

/**
 * Receiving-station verification of driver-to-station handovers. Every parcel is decided and committed
 * on its own, so one missing or damaged parcel never blocks the others in the same batch.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(private readonly ctx: WorkflowContext, private readonly journey: JourneyService) {}

  private get prisma() { return this.ctx.prisma; }

  /**
   * The handover a station can verify for a parcel: dropped here, or still COLLECTED on a trip standing
   * here with this as its drop station (implicit drop), or on a trip stopped by a custody exception.
   */
  private async pendingHandover(parcelId: string, stationId: string) {
    const candidates = await this.prisma.parcelAssignment.findMany({ where: { parcelId, status: { in: [AssignmentStatus.DROPPED, AssignmentStatus.COLLECTED] } }, include: { leg: true, trip: true } });
    return candidates.find((item) => {
      if (item.status === AssignmentStatus.DROPPED) return item.dropTransitPointId === stationId;
      if (!item.trip || !item.leg) return false;
      if (item.trip.status === TripStatus.CANCELLED) return true;
      return item.leg.toTransitPointId === stationId && item.trip.currentTransitPointId === stationId && item.trip.atStop;
    });
  }

  async verify(actor: Actor, data: { transitPointId: string; items: VerificationItem[] }): Promise<{ results: VerificationResult[]; summary: Record<string, number> }> {
    if (!data?.transitPointId) throw new BadRequestException('Choose the transit point receiving the parcels');
    if (!Array.isArray(data.items) || !data.items.length) throw new BadRequestException('Select at least one parcel to verify');
    if (new Set(data.items.map((item) => item.parcelId)).size !== data.items.length) throw new BadRequestException('A parcel can only appear once per verification');
    for (const item of data.items) {
      if (!VERIFICATION_OUTCOMES.includes(item.outcome)) throw new BadRequestException(`Choose VERIFIED, MISSING, DAMAGED or TAMPER_ALERT for every parcel`);
      if (item.condition && !Object.values(SealCondition).includes(item.condition)) throw new BadRequestException('Invalid seal condition');
    }
    await this.ctx.assertStation(actor, data.transitPointId, 'You can only verify parcels at your assigned transit point');
    const network = await this.ctx.network();
    const station = network.point(data.transitPointId)?.name ?? 'station';
    const results: VerificationResult[] = [];
    for (const item of data.items) {
      try {
        results.push(await this.verifyOne(actor, data.transitPointId, station, item, network));
      } catch (error) {
        this.logger.warn(`Verification of ${item.parcelId} failed: ${error instanceof Error ? error.message : error}`);
        results.push({ parcelId: item.parcelId, result: 'ERROR', message: error instanceof Error ? error.message : 'Verification failed' });
      }
    }
    const summary = results.reduce<Record<string, number>>((acc, result) => ({ ...acc, [result.result]: (acc[result.result] ?? 0) + 1 }), {});
    this.ctx.emit('stationWorkUpdate', { kind: 'VERIFIED', transitPointId: data.transitPointId, summary }, { transitPointIds: [data.transitPointId] });
    return { results, summary };
  }

  /**
   * A parcel physically presented at the counter, identified by tracking number (or seal id). If the
   * station expects it, it is verified normally; otherwise it is recorded as UNEXPECTED.
   */
  async receiveByTracking(actor: Actor, data: { transitPointId: string; trackingNumber: string; outcome?: VerificationOutcome; notes?: string }) {
    const reference = data?.trackingNumber?.trim();
    if (!reference) throw new BadRequestException('Enter the tracking number or seal identifier on the parcel');
    await this.ctx.assertStation(actor, data.transitPointId, 'You can only receive parcels at your assigned transit point');
    const parcel = await this.prisma.parcel.findFirst({ where: { deletedAt: null, OR: [{ trackingNumber: reference }, { qrSealIdentifier: reference }] }, select: { id: true } });
    if (!parcel) throw new NotFoundException('No parcel has that tracking number or seal');
    return this.verify(actor, { transitPointId: data.transitPointId, items: [{ parcelId: parcel.id, outcome: data.outcome ?? 'VERIFIED', notes: data.notes }] });
  }

  private async verifyOne(actor: Actor, stationId: string, station: string, item: VerificationItem, network: Awaited<ReturnType<WorkflowContext['network']>>): Promise<VerificationResult> {
    const parcel = await this.prisma.parcel.findFirst({ where: { id: item.parcelId, deletedAt: null } });
    if (!parcel) return { parcelId: item.parcelId, result: 'ERROR', message: 'Parcel not found' };
    const handover = await this.pendingHandover(parcel.id, stationId);

    if (!handover) {
      const verified = await this.prisma.transitInspection.findFirst({ where: { parcelId: parcel.id, transitPointId: stationId, assignmentId: { not: null } }, orderBy: { inspectedAt: 'desc' } });
      if (verified && parcel.currentTransitPointId === stationId && parcel.custody !== CustodyHolder.HANDOVER) {
        return { parcelId: parcel.id, trackingNumber: parcel.trackingNumber, result: 'ALREADY_VERIFIED', message: `${parcel.trackingNumber} was already verified here` };
      }
      // Not expected here: record it and raise an exception; it is never added to a batch automatically.
      const alert = await this.prisma.$transaction(async (tx) => {
        await tx.transitInspection.create({ data: { parcelId: parcel.id, transitPointId: stationId, officerId: actor.id, condition: item.condition ?? null, decision: 'UNEXPECTED', notes: item.notes } });
        await this.ctx.history(tx, { parcelId: parcel.id, status: parcel.status, location: station, updatedBy: actor.id, notes: `Presented at ${station} but not expected there; held for authorised handling.` });
        return this.ctx.raiseAlert(tx, { parcelId: parcel.id, type: TamperAlertType.UNEXPECTED_PARCEL, transitPointId: stationId, details: `${parcel.trackingNumber} arrived at ${station} unexpectedly (system shows: ${parcel.status.replaceAll('_', ' ')}, custody ${parcel.custody.toLowerCase()}).${item.notes ? ` ${item.notes}` : ''}` });
      }, TX_OPTIONS);
      if (alert.created) await this.ctx.announceAlert(alert.alert, parcel.trackingNumber);
      return { parcelId: parcel.id, trackingNumber: parcel.trackingNumber, result: 'UNEXPECTED', message: `${parcel.trackingNumber} is not expected at ${station}; an exception was raised` };
    }

    const { leg, trip } = handover;
    const condition = item.condition ?? (item.outcome === 'VERIFIED' ? SealCondition.INTACT : item.outcome === 'DAMAGED' ? SealCondition.DAMAGED : item.outcome === 'TAMPER_ALERT' ? SealCondition.BROKEN : null);
    if (item.outcome === 'VERIFIED' && condition && condition !== SealCondition.INTACT) {
      return { parcelId: parcel.id, trackingNumber: parcel.trackingNumber, result: 'ERROR', message: 'A parcel with a damaged or broken seal must be recorded as DAMAGED or TAMPER_ALERT' };
    }
    const driver = await this.prisma.user.findUnique({ where: { id: handover.driverId }, select: { name: true, phone: true } });

    let settlement: Settlement | null = null;
    let alertToAnnounce: { alert: any; created: boolean } | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        if (leg) await this.ctx.lock(tx, 'parcel_legs', leg.id);
        const fresh = await tx.parcelAssignment.findUniqueOrThrow({ where: { id: handover.id } });
        if (fresh.status !== AssignmentStatus.DROPPED && fresh.status !== AssignmentStatus.COLLECTED) throw new AlreadyHandled();
        if (await tx.transitInspection.findUnique({ where: { assignmentId: handover.id } })) throw new AlreadyHandled();
        const now = new Date();
        // Racing submissions that pass the check above still fail here on the unique assignmentId.
        await tx.transitInspection.create({ data: { tripId: handover.tripId, parcelId: parcel.id, transitPointId: stationId, officerId: actor.id, assignmentId: handover.id, legId: handover.legId, condition, decision: item.outcome, notes: item.notes } });
        const dropFields = { droppedAt: fresh.droppedAt ?? now, dropTransitPointId: stationId };
        const suffix = item.notes ? ` — ${item.notes}` : '';

        if (item.outcome === 'VERIFIED') {
          await tx.parcelAssignment.update({ where: { id: handover.id }, data: { ...dropFields, status: AssignmentStatus.DROPPED } });
          if (leg && !leg.droppedAt) await tx.parcelLeg.update({ where: { id: leg.id }, data: { droppedAt: now } });
          settlement = await this.journey.settleAtStation(tx, network, { parcelId: parcel.id, stationId, actorId: actor.id, reason: `verified by the station${suffix}` });
          await this.ctx.resolveAlerts(tx, parcel.id, [TamperAlertType.CUSTODY_EXCEPTION, TamperAlertType.UNEXPECTED_PARCEL], `Received and verified at ${station}`, actor.id);
          return;
        }
        if (item.outcome === 'MISSING') {
          await tx.parcelAssignment.update({ where: { id: handover.id }, data: { ...dropFields, status: AssignmentStatus.DROPPED } });
          if (leg) await tx.parcelLeg.update({ where: { id: leg.id }, data: { status: ParcelLegStatus.EXCEPTION, droppedAt: leg.droppedAt ?? now } });
          await tx.parcel.update({ where: { id: parcel.id }, data: { status: ParcelStatus.tampering_alert, custody: CustodyHolder.UNKNOWN, currentTransitPointId: stationId, currentLocation: station } });
          await this.ctx.history(tx, { parcelId: parcel.id, status: ParcelStatus.tampering_alert, location: station, updatedBy: actor.id, notes: `Expected at ${station} but not received from driver ${driver?.name ?? ''}; under investigation${suffix}` });
          alertToAnnounce = await this.ctx.raiseAlert(tx, { parcelId: parcel.id, type: TamperAlertType.PARCEL_MISSING, transitPointId: stationId, legId: handover.legId, tripId: handover.tripId, assignmentId: handover.id, details: `Not received at ${station} from driver ${driver?.name ?? ''} (${driver?.phone ?? 'no phone'}), trip ${trip?.tripNumber ?? ''}.${suffix}` });
          return;
        }
        // DAMAGED / TAMPER_ALERT: the station holds the parcel, but its journey pauses for investigation.
        await tx.parcelAssignment.update({ where: { id: handover.id }, data: { ...dropFields, status: AssignmentStatus.COMPLETED, completedAt: now } });
        if (leg) await tx.parcelLeg.update({ where: { id: leg.id }, data: { status: ParcelLegStatus.EXCEPTION, droppedAt: leg.droppedAt ?? now } });
        await tx.parcel.update({ where: { id: parcel.id }, data: { status: ParcelStatus.tampering_alert, custody: CustodyHolder.STATION, currentTransitPointId: stationId, currentLocation: station } });
        const type = item.outcome === 'DAMAGED' ? TamperAlertType.PARCEL_DAMAGED : condition === SealCondition.QR_MISMATCH ? TamperAlertType.QR_MISMATCH : TamperAlertType.SEAL_BROKEN;
        await this.ctx.history(tx, { parcelId: parcel.id, status: ParcelStatus.tampering_alert, location: station, updatedBy: actor.id, notes: `Received at ${station} ${item.outcome === 'DAMAGED' ? 'damaged' : 'with a security (tamper) alert'}; held for review${suffix}` });
        alertToAnnounce = await this.ctx.raiseAlert(tx, { parcelId: parcel.id, type, transitPointId: stationId, legId: handover.legId, tripId: handover.tripId, assignmentId: handover.id, details: `${item.outcome === 'DAMAGED' ? 'Damaged' : 'Tamper alert'} on receipt at ${station} from driver ${driver?.name ?? ''}, trip ${trip?.tripNumber ?? ''}.${suffix}` });
      }, TX_OPTIONS);
    } catch (error: any) {
      if (error instanceof AlreadyHandled || error?.code === 'P2002') return { parcelId: parcel.id, trackingNumber: parcel.trackingNumber, result: 'ALREADY_VERIFIED', message: `${parcel.trackingNumber} was already verified` };
      throw error;
    }

    if (settlement) await this.journey.afterSettlement(settlement);
    const raised = alertToAnnounce as { alert: any; created: boolean } | null;
    if (raised?.created) await this.ctx.announceAlert(raised.alert, parcel.trackingNumber);
    const messages: Record<VerificationOutcome, string> = {
      VERIFIED: `${parcel.trackingNumber} verified`,
      MISSING: `${parcel.trackingNumber} recorded as missing; an exception was raised`,
      DAMAGED: `${parcel.trackingNumber} recorded as damaged and held for review`,
      TAMPER_ALERT: `${parcel.trackingNumber} held with a tamper alert`,
    };
    return { parcelId: parcel.id, trackingNumber: parcel.trackingNumber, result: item.outcome, message: messages[item.outcome] };
  }
}

class AlreadyHandled extends Error {}
