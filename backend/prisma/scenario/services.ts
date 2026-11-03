/**
 * The real workflow services wired without Nest's container, for the seed and the journey tests.
 * Mail is captured instead of sent; realtime events are recorded instead of emitted.
 */
import { PrismaService } from '../../src/database/prisma.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { WorkflowContext } from '../../src/operations/workflow/workflow-context.service';
import { DispatchService } from '../../src/operations/workflow/dispatch.service';
import { CollectionService } from '../../src/operations/workflow/collection.service';
import { JourneyService } from '../../src/operations/workflow/journey.service';
import { TripsService } from '../../src/operations/workflow/trips.service';
import { VerificationService } from '../../src/operations/workflow/verification.service';
import { StationQueuesService } from '../../src/operations/workflow/station-queues.service';
import { OperationsService } from '../../src/operations/operations.service';
import { ParcelsService } from '../../src/parcels/parcels.service';

export type SentMail = { to: string; subject: string; template?: string; context?: Record<string, unknown> };
export type EmittedEvent = { event: string; payload: object; audience: object };

export function buildWorkflowServices(prisma: PrismaService) {
  const mail: SentMail[] = [];
  const events: EmittedEvent[] = [];
  const mailer: any = new Proxy({}, { get: () => async (payload: SentMail) => { if (payload?.to) mail.push(payload); } });
  const gateway: any = {
    emitWorkflowEvent: (event: string, payload: object, audience: object) => events.push({ event, payload, audience }),
    broadcastNotification: () => undefined,
  };
  const notifications = new NotificationsService(prisma, gateway);
  const ctx = new WorkflowContext(prisma, notifications, gateway);
  const dispatch = new DispatchService(ctx);
  const collection = new CollectionService(ctx, mailer);
  const journey = new JourneyService(ctx, dispatch, collection, mailer);
  const trips = new TripsService(ctx, dispatch);
  const verification = new VerificationService(ctx, journey);
  const queues = new StationQueuesService(ctx, dispatch, journey);
  const operations = new OperationsService(prisma, ctx, journey, dispatch, collection);
  const parcels = new ParcelsService(prisma, mailer, notifications, journey);
  return { prisma, ctx, dispatch, collection, journey, trips, verification, queues, operations, parcels, notifications, mail, events };
}

export type WorkflowServices = ReturnType<typeof buildWorkflowServices>;
