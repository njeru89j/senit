import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CustodyHolder, ParcelStatus } from '@prisma/client';
import { DispatchService } from './dispatch.service';
import { CollectionService } from './collection.service';
import { TX_OPTIONS, WorkflowContext } from './workflow-context.service';

const UNCONFIRMED_EXPIRY_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * Server-side timers. All state lives in the database (deadline columns), so a restart loses nothing:
 * the next sweep picks up whatever fell due. Every step is a conditional update, so overlapping runs
 * (or several app instances) cannot apply the same transition twice.
 */
@Injectable()
export class WorkflowSweepsService {
  private readonly logger = new Logger(WorkflowSweepsService.name);
  private readonly running = new Set<string>();

  constructor(private readonly ctx: WorkflowContext, private readonly dispatch: DispatchService, private readonly collection: CollectionService) {}

  private async once(name: string, job: () => Promise<unknown>) {
    if (this.running.has(name)) return;
    this.running.add(name);
    try {
      await job();
    } catch (error) {
      this.logger.error(`${name} sweep failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.running.delete(name);
    }
  }

  /** 3-hour driver acceptance window. */
  @Cron(CronExpression.EVERY_MINUTE)
  async acceptanceSweep() {
    await this.once('acceptance', async () => {
      const expired = await this.dispatch.expireOverdueOffers();
      if (expired) this.logger.log(`Expired ${expired} unaccepted assignment(s)`);
    });
  }

  /** Locker codes, the 12-hour station window, unconfirmed bookings, and a low-frequency safety retry for waiting legs. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async periodicSweep() {
    await this.once('periodic', async () => {
      await this.collection.expireLockerCodes();
      await this.collection.collectionSweep();
      await this.expireUnconfirmed();
      await this.dispatch.retryWaitingLegs({ olderThanMs: RETRY_AFTER_MS });
    });
  }

  /** A booking never handed over at the origin station within 24 hours is cancelled. */
  async expireUnconfirmed(now = new Date()) {
    const expired = await this.ctx.prisma.parcel.findMany({ where: { status: ParcelStatus.awaiting_confirmation, custody: CustodyHolder.SENDER, createdAt: { lt: new Date(now.getTime() - UNCONFIRMED_EXPIRY_MS) }, deletedAt: null }, select: { id: true, pickupAddress: true } });
    for (const parcel of expired) {
      await this.ctx.prisma.$transaction(async (tx) => {
        const updated = await tx.parcel.updateMany({ where: { id: parcel.id, status: ParcelStatus.awaiting_confirmation }, data: { status: ParcelStatus.cancelled, notes: 'Expired: not handed over at the origin station within 24 hours.' } });
        if (!updated.count) return;
        await tx.lockerRequest.updateMany({ where: { parcelId: parcel.id, status: 'PENDING' }, data: { status: 'REJECTED', reviewedAt: now } });
        await this.ctx.history(tx, { parcelId: parcel.id, status: ParcelStatus.cancelled, location: parcel.pickupAddress, notes: 'Expired after 24 hours without hand-over at the origin station.' });
      }, TX_OPTIONS);
    }
    return expired.length;
  }
}
