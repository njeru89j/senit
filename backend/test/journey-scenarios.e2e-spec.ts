/**
 * End-to-end parcel journey scenarios against a disposable database.
 *
 * Runs only against a database named `sendit_scenarios` (derived from DATABASE_URL in .env) because every
 * run wipes it. Prepare it once (and after new migrations) with:
 *   DATABASE_URL=<.env url with /sendit_scenarios> npx prisma migrate reset --force --skip-seed
 * Mail and realtime events are captured, never sent.
 *
 * Part 1 replays the seeded "day on the corridor" scenario (prisma/scenario/story.ts) and asserts it.
 * Part 2 exercises every failure and exception path on a fresh copy of the same network.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const envUrl = readFileSync(join(__dirname, '..', '.env'), 'utf8').match(/^DATABASE_URL="?([^"\n]+)"?/m)?.[1] ?? '';
process.env.DATABASE_URL = envUrl.replace(/\/[^/?]+\?/, '/sendit_scenarios?');

import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AlertStatus, AssignmentStatus, ParcelLegStatus, ParcelStatus, TripStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../src/database/prisma.service';
import { WorkflowSweepsService } from '../src/operations/workflow/workflow-sweeps.service';
import { buildScenarioNetwork, ScenarioNetwork, STATIONS } from '../prisma/scenario/network';
import { buildWorkflowServices, WorkflowServices } from '../prisma/scenario/services';
import { runCorridorStory, scenarioHelpers, StoryResult } from '../prisma/scenario/story';

jest.setTimeout(120_000);

const prisma = new PrismaService();
let s: WorkflowServices;
let net: ScenarioNetwork;

async function wipe() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((table) => `"${table.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}
const parcel = (id: string) => prisma.parcel.findUniqueOrThrow({ where: { id } });
const legs = (parcelId: string) => prisma.parcelLeg.findMany({ where: { parcelId }, orderBy: { sequence: 'asc' }, include: { assignments: { orderBy: { assignedAt: 'asc' } } } });
const active = (parcelId: string) => prisma.parcelAssignment.findFirst({ where: { parcelId, status: { in: [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED, AssignmentStatus.COLLECTED, AssignmentStatus.DROPPED] } } });
const codeFor = async (userId: string, parcelId: string) => (await prisma.notification.findFirstOrThrow({ where: { userId, parcelId, title: 'Smart locker collection code' }, orderBy: { createdAt: 'desc' } })).message.match(/code (\d{6})/)![1];
const admin = () => prisma.user.create({ data: { email: `admin-${Date.now()}@test.local`, password: 'x', name: 'Admin', role: UserRole.ADMIN } });

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes('/sendit_scenarios?')) throw new Error('Refusing to run: the scenario tests only run against the sendit_scenarios database');
  await prisma.$connect();
  s = buildWorkflowServices(prisma);
});
afterAll(() => prisma.$disconnect());

describe('Part 1 — the seeded corridor scenario', () => {
  let story: StoryResult;
  beforeAll(async () => {
    await wipe();
    net = await buildScenarioNetwork(prisma);
    story = await runCorridorStory(s, net);
  });

  it('P1 Meru → Kiambu: two legs, two drivers, one parcel, transfer at Nairobi, then a smart locker', async () => {
    const p1 = await parcel(story.parcels.P1);
    expect(p1).toMatchObject({ status: ParcelStatus.in_locker, custody: 'LOCKER', trackingNumber: expect.any(String) });
    const [leg1, leg2] = await legs(p1.id);
    expect([leg1.fromTransitPointId, leg1.toTransitPointId, leg1.routeId]).toEqual([net.stations.meru, net.stations.nairobi, net.routes.meruNairobi]);
    expect([leg2.fromTransitPointId, leg2.toTransitPointId, leg2.routeId]).toEqual([net.stations.nairobi, net.stations.kiambu, net.routes.nairobiKiambu]);
    expect([leg1.status, leg2.status]).toEqual([ParcelLegStatus.COMPLETED, ParcelLegStatus.COMPLETED]);
    expect(leg1.assignments.at(-1)!.driverId).toBe(net.drivers.peter.id);
    expect(leg2.assignments.at(-1)!.driverId).toBe(net.drivers.grace.id);
    expect(await prisma.parcel.count({ where: { trackingNumber: p1.trackingNumber } })).toBe(1);
    const code = await codeFor(net.customers.brian.id, p1.id);
    expect(code).toMatch(/^\d{6}$/);
    expect(await prisma.notification.count({ where: { userId: net.customers.alice.id, parcelId: p1.id, message: { contains: code } } })).toBe(0);
  });

  it('P1 customer tracking reads as one journey in plain language', async () => {
    const view = await s.journey.journeyView(story.parcels.P1, 'customer');
    expect(view.stops.map((stop: any) => stop.name)).toEqual(['Meru', 'Chuka', 'Thika', 'Juja', 'Nairobi', 'Ruaka', 'Kiambu']);
    expect(view.stops.map((stop: any) => stop.role)).toEqual(['ORIGIN', 'PASS', 'PASS', 'PASS', 'TRANSFER', 'PASS', 'DESTINATION']);
    const nairobi = view.stops[4];
    expect(nairobi.events.map((event: any) => event.label)).toEqual(['Arrived', 'Verified at station', 'Connecting route assigned', 'Connecting driver collected']);
    expect(view.statusLabel).toBe('In smart locker');
    expect(JSON.stringify({ stops: view.stops, legs: view.legs, statusLabel: view.statusLabel })).not.toMatch(/AWAITING_DRIVER|DRIVER_ASSIGNED|IN_TRANSIT|READY_NEXT|COMPLETED/);
    expect(view.internal).toBeUndefined();
  });

  it('P2 rode a Meru → Nairobi trip but was dropped at Juja, verified, and collected at the counter', async () => {
    const p2 = await parcel(story.parcels.P2);
    expect(p2).toMatchObject({ status: ParcelStatus.delivered, custody: 'RECIPIENT' });
    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: story.trips.peter } });
    expect(trip).toMatchObject({ status: TripStatus.CLOSED, currentTransitPointId: net.stations.nairobi });
  });

  it('P3 was picked up mid-trip at Chuka and waits at Juja with a 12-hour deadline', async () => {
    const p3 = await parcel(story.parcels.P3);
    expect(p3).toMatchObject({ status: ParcelStatus.at_destination, custody: 'STATION', currentTransitPointId: net.stations.juja });
    expect(p3.collectionDeadlineAt!.getTime() - p3.readyForCollectionAt!.getTime()).toBe(12 * 3600_000);
    const [leg] = await legs(p3.id);
    expect(leg.assignments[0]).toMatchObject({ driverId: net.drivers.peter.id, tripId: story.trips.peter, status: AssignmentStatus.COMPLETED });
  });

  it('P4 Nairobi → Juja waits for a driver and explains why', async () => {
    const [leg] = await legs(story.parcels.P4);
    expect(leg).toMatchObject({ status: ParcelLegStatus.AWAITING_DRIVER, direction: 'REVERSE', noDriverReason: 'NO_OPEN_TRIP_ON_SEGMENT' });
    const queues = await s.queues.queues({ id: net.officers.nairobi.id, role: UserRole.TRANSIT_OFFICER });
    expect(queues.queues!.awaitingDriver.map((item: any) => item.id)).toContain(story.parcels.P4);
    expect(await prisma.notification.count({ where: { userId: net.officers.nairobi.id, parcelId: story.parcels.P4, type: 'OFFICER_ACTION_REQUIRED' } })).toBe(1);
  });

  it('P5 was rejected by John and re-offered to Mary with a 3-hour window', async () => {
    const [leg] = await legs(story.parcels.P5);
    expect(leg.assignments.map((item) => [item.driverId, item.status])).toEqual([[net.drivers.john.id, AssignmentStatus.REJECTED], [net.drivers.mary.id, AssignmentStatus.ASSIGNED]]);
    const offer = leg.assignments[1];
    expect(offer.acceptanceDeadline!.getTime() - offer.assignedAt.getTime()).toBe(3 * 3600_000);
    const workspace = await s.trips.workspace(net.drivers.mary.id);
    expect(workspace.offers.map((item: any) => item.parcelId)).toEqual([story.parcels.P5]);
    expect(workspace.capacity).toMatchObject({ capacityKg: 300, reservedKg: 30, loadedKg: 0, availableKg: 270 });
  });

  it('P7 is booked but not handed over: no journey is frozen yet, the planned route is previewed', async () => {
    expect(await parcel(story.parcels.P7)).toMatchObject({ status: ParcelStatus.awaiting_confirmation, custody: 'SENDER' });
    expect(await legs(story.parcels.P7)).toHaveLength(0);
    const view = await s.journey.journeyView(story.parcels.P7, 'customer');
    expect(view.planned).toBe(true);
    expect(view.legs.map((leg: any) => `${leg.from}→${leg.to}`)).toEqual(['Kiambu→Nairobi', 'Nairobi→Nakuru']);
  });

  it('P8 missing and P9 damaged are exceptions at their stations, not normal progress', async () => {
    expect(await parcel(story.parcels.P8)).toMatchObject({ status: ParcelStatus.tampering_alert, custody: 'UNKNOWN' });
    expect(await parcel(story.parcels.P9)).toMatchObject({ status: ParcelStatus.tampering_alert, custody: 'STATION', currentTransitPointId: net.stations.naivasha });
    const nakuru = await s.queues.queues({ id: net.officers.nakuru.id, role: UserRole.TRANSIT_OFFICER });
    expect(nakuru.queues!.exceptions.map((item: any) => item.type)).toContain('PARCEL_MISSING');
    const [leg8] = await legs(story.parcels.P8);
    expect(leg8.status).toBe(ParcelLegStatus.EXCEPTION);
  });

  it('stop activity is derived per stop, every stop stays visible', async () => {
    const workspace = await s.trips.workspace(net.drivers.mary.id);
    expect(workspace.trip.stops.map((stop: any) => [stop.name, stop.active])).toEqual([['Meru', true], ['Chuka', false], ['Thika', false], ['Juja', false], ['Nairobi', true]]);
    expect(workspace.trip.stops[0]).toMatchObject({ pickupCount: 1, operations: ['PICKUP'] });
    // P5 is only offered, not collected, so Nairobi is active as the route endpoint, not yet as a drop-off.
    expect(workspace.trip.stops[4]).toMatchObject({ dropoffCount: 0, operations: ['ROUTE_ENDPOINT'] });
  });

  it('custody is always knowable and no leg ever has two active assignments', async () => {
    const all = await prisma.parcel.findMany({ include: { legs: { include: { assignments: true } } } });
    for (const item of all) {
      if (item.custody === 'DRIVER') expect(item.legs.some((leg) => leg.assignments.some((a) => a.status === AssignmentStatus.COLLECTED))).toBe(true);
      if (item.custody === 'STATION' || item.custody === 'HANDOVER') expect(item.currentTransitPointId).toBeTruthy();
      for (const leg of item.legs) expect(leg.assignments.filter((a) => ([AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED, AssignmentStatus.COLLECTED, AssignmentStatus.DROPPED] as AssignmentStatus[]).includes(a.status)).length).toBeLessThanOrEqual(1);
    }
    const history = await prisma.parcelStatusHistory.count({ where: { parcelId: story.parcels.P1 } });
    expect(history).toBeGreaterThanOrEqual(10);
  });

  it('realtime events went to the right audiences', () => {
    expect(s.events.some((item) => item.event === 'assignmentUpdate')).toBe(true);
    expect(s.events.some((item) => item.event === 'tripUpdate' && (item.payload as any).status === TripStatus.IN_TRANSIT)).toBe(true);
    expect(s.events.some((item) => item.event === 'stationWorkUpdate' && (item.payload as any).kind === 'AWAITING_VERIFICATION')).toBe(true);
  });
});

describe('Part 2 — failure and exception paths', () => {
  let h: ReturnType<typeof scenarioHelpers>;
  beforeEach(async () => {
    await wipe();
    net = await buildScenarioNetwork(prisma);
    h = scenarioHelpers(s, net);
  });
  const book = (from: keyof typeof STATIONS, dest: keyof typeof STATIONS, weight = 5, method: 'STATION_COLLECTION' | 'SMART_LOCKER' = 'STATION_COLLECTION') =>
    h.book('alice', { to: 'brian', from, dest, weight, method, description: `${from} → ${dest}` });

  it('origin confirmation is idempotent under a double submission', async () => {
    await h.openTrip('peter', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi');
    const [a, b] = await Promise.all([s.journey.confirmAtOrigin(id, h.officer('meru')), s.journey.confirmAtOrigin(id, h.officer('meru'))]);
    expect(a.parcel.status).toBe(ParcelStatus.at_origin_transit_point);
    expect(b.parcel.status).toBe(ParcelStatus.at_origin_transit_point);
    expect(await prisma.parcelLeg.count({ where: { parcelId: id } })).toBe(1);
    expect(await prisma.parcelAssignment.count({ where: { parcelId: id } })).toBe(1);
    expect(await prisma.parcelStatusHistory.count({ where: { parcelId: id, notes: { contains: 'physically received and confirmed' } } })).toBe(1);
  });

  it('two simultaneous heavy confirmations cannot both consume the same vehicle capacity', async () => {
    await h.openTrip('mary', 'meruNairobi', 'meru'); // 300 kg car
    const x = await book('meru', 'nairobi', 200);
    const y = await book('meru', 'nairobi', 200);
    await Promise.all([s.journey.confirmAtOrigin(x, h.officer('meru')), s.journey.confirmAtOrigin(y, h.officer('meru'))]);
    const offers = await prisma.parcelAssignment.findMany({ where: { driverId: net.drivers.mary.id, status: AssignmentStatus.ASSIGNED } });
    expect(offers).toHaveLength(1);
    const waiting = await prisma.parcelLeg.findFirstOrThrow({ where: { parcelId: { in: [x, y] }, status: ParcelLegStatus.AWAITING_DRIVER } });
    expect(waiting.noDriverReason).toBe('INSUFFICIENT_CAPACITY');
  });

  it('an unaccepted offer expires server-side after 3 hours and moves to the next driver; an accepted one never expires', async () => {
    await h.openTrip('john', 'meruNairobi', 'meru');
    await h.openTrip('mary', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi', 10);
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    const johnOffer = await h.offer(id);
    expect(johnOffer.driverId).toBe(net.drivers.john.id);
    await prisma.parcelAssignment.update({ where: { id: johnOffer.id }, data: { acceptanceDeadline: new Date(Date.now() - 1000) } });
    expect(await s.dispatch.expireOverdueOffers()).toBe(1);
    expect(await prisma.parcelAssignment.findUniqueOrThrow({ where: { id: johnOffer.id } })).toMatchObject({ status: AssignmentStatus.EXPIRED, expiredAt: expect.any(Date) });
    const maryOffer = await h.offer(id);
    expect(maryOffer.driverId).toBe(net.drivers.mary.id);
    await s.dispatch.accept(maryOffer.id, net.drivers.mary.id);
    await prisma.parcelAssignment.update({ where: { id: maryOffer.id }, data: { acceptanceDeadline: new Date(Date.now() - 1000) } });
    expect(await s.dispatch.expireOverdueOffers()).toBe(0);
    expect((await prisma.parcelAssignment.findUniqueOrThrow({ where: { id: maryOffer.id } })).status).toBe(AssignmentStatus.ACCEPTED);
    expect(await prisma.notification.count({ where: { userId: net.drivers.john.id, title: 'Assignment expired' } })).toBe(1);
  });

  it('accepting after the deadline is refused even before the sweep has run', async () => {
    await h.openTrip('john', 'meruNairobi', 'meru');
    await h.openTrip('mary', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi', 10);
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    const johnOffer = await h.offer(id);
    await prisma.parcelAssignment.update({ where: { id: johnOffer.id }, data: { acceptanceDeadline: new Date(Date.now() - 1000) } });
    await expect(s.dispatch.accept(johnOffer.id, net.drivers.john.id)).rejects.toBeInstanceOf(ConflictException);
    expect((await h.offer(id)).driverId).toBe(net.drivers.mary.id);
  });

  it('an officer cancels an accepted assignment; it is reassigned and the cancelled driver cannot collect', async () => {
    await h.openTrip('peter', 'meruNairobi', 'meru');
    await h.openTrip('john', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi', 10);
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    const peterOffer = await h.offer(id);
    expect(peterOffer.driverId).toBe(net.drivers.peter.id);
    await s.dispatch.accept(peterOffer.id, net.drivers.peter.id);
    await expect(s.dispatch.cancelByStaff(peterOffer.id, h.officer('chuka'), 'Driver did not show up')).rejects.toBeInstanceOf(NotFoundException);
    await s.dispatch.cancelByStaff(peterOffer.id, h.officer('meru'), 'Driver did not show up');
    expect(await prisma.parcelAssignment.findUniqueOrThrow({ where: { id: peterOffer.id } })).toMatchObject({ status: AssignmentStatus.CANCELLED, cancelledBy: net.officers.meru.id, cancellationReason: expect.stringContaining('did not show up') });
    await expect(s.trips.collect(peterOffer.id, net.drivers.peter.id)).rejects.toBeInstanceOf(ConflictException);
    expect((await h.offer(id)).driverId).toBe(net.drivers.john.id);
  });

  it('a rejection with no alternative driver leaves the parcel waiting and alerts the station once', async () => {
    await h.openTrip('john', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi', 10);
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    await s.dispatch.reject((await h.offer(id)).id, net.drivers.john.id, 'Vehicle broke down');
    const [leg] = await legs(id);
    expect(leg).toMatchObject({ status: ParcelLegStatus.AWAITING_DRIVER, noDriverReason: 'ALL_DECLINED' });
    await s.dispatch.retryWaitingLegs();
    expect(await prisma.parcelAssignment.count({ where: { parcelId: id, driverId: net.drivers.john.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: net.officers.meru.id, parcelId: id, type: 'OFFICER_ACTION_REQUIRED' } })).toBe(1);
  });

  it('never assigns against the direction of travel or to a trip that has passed the pickup', async () => {
    const trip = await h.openTrip('peter', 'meruNairobi', 'meru');
    await s.trips.startTrip(trip, net.drivers.peter.id);
    await s.trips.arrive(trip, net.drivers.peter.id, net.stations.thika);
    const passed = await book('chuka', 'juja');
    await s.journey.confirmAtOrigin(passed, h.officer('chuka'));
    expect((await legs(passed))[0]).toMatchObject({ status: ParcelLegStatus.AWAITING_DRIVER, noDriverReason: 'ALL_PASSED_PICKUP' });
    const reverse = await book('thika', 'meru');
    await s.journey.confirmAtOrigin(reverse, h.officer('thika'));
    expect((await legs(reverse))[0].status).toBe(ParcelLegStatus.AWAITING_DRIVER);
    const here = await book('thika', 'juja');
    await s.journey.confirmAtOrigin(here, h.officer('thika'));
    expect((await h.offer(here)).driverId).toBe(net.drivers.peter.id);
  });

  it('pickups the vehicle leaves behind are withdrawn and offered to a driver still behind it', async () => {
    const peterTrip = await h.openTrip('peter', 'meruNairobi', 'meru');
    await h.openTrip('john', 'meruNairobi', 'meru');
    const id = await book('chuka', 'nairobi');
    await s.journey.confirmAtOrigin(id, h.officer('chuka'));
    const peterOffer = await h.offer(id);
    expect(peterOffer.driverId).toBe(net.drivers.peter.id);
    await s.dispatch.accept(peterOffer.id, net.drivers.peter.id);
    await s.trips.startTrip(peterTrip, net.drivers.peter.id);
    await s.trips.arrive(peterTrip, net.drivers.peter.id, net.stations.chuka);
    await s.trips.depart(peterTrip, net.drivers.peter.id);
    expect(await prisma.parcelAssignment.findUniqueOrThrow({ where: { id: peterOffer.id } })).toMatchObject({ status: AssignmentStatus.CANCELLED, cancellationReason: expect.stringContaining('passed the pickup') });
    expect((await h.offer(id)).driverId).toBe(net.drivers.john.id);
  });

  it('Start Delivery moves only collected parcels, cannot run twice, and releases uncollected start-station pickups', async () => {
    const trip = await h.openTrip('peter', 'meruNairobi', 'meru');
    const collected = await book('meru', 'nairobi');
    const notCollected = await book('meru', 'juja');
    await s.journey.confirmAtOrigin(collected, h.officer('meru'));
    await s.journey.confirmAtOrigin(notCollected, h.officer('meru'));
    await h.acceptAndCollect(collected, 'peter');
    await s.dispatch.accept((await h.offer(notCollected)).id, net.drivers.peter.id);
    const first = await s.trips.startTrip(trip, net.drivers.peter.id);
    const startedAt = first.trip.startedAt;
    expect(first.trip.canStart).toBe(false);
    expect((await parcel(collected)).status).toBe(ParcelStatus.in_transit);
    expect(await parcel(notCollected)).toMatchObject({ status: ParcelStatus.at_origin_transit_point, custody: 'STATION' });
    expect((await legs(notCollected))[0].status).toBe(ParcelLegStatus.AWAITING_DRIVER);
    const again = await s.trips.startTrip(trip, net.drivers.peter.id);
    expect(again.trip.startedAt).toEqual(startedAt);
  });

  it('a driver cannot skip a drop-off or leave with parcels due, and completes only at the route endpoint', async () => {
    const trip = await h.openTrip('peter', 'meruNairobi', 'meru');
    const id = await book('meru', 'juja');
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    await h.acceptAndCollect(id, 'peter');
    await s.trips.startTrip(trip, net.drivers.peter.id);
    await expect(s.trips.arrive(trip, net.drivers.peter.id, net.stations.nairobi)).rejects.toThrow('stop there first');
    await s.trips.arrive(trip, net.drivers.peter.id, net.stations.juja);
    await expect(s.trips.depart(trip, net.drivers.peter.id)).rejects.toThrow('before departing');
    await expect(s.trips.complete(trip, net.drivers.peter.id)).rejects.toBeInstanceOf(BadRequestException);
    await s.trips.drop(trip, net.drivers.peter.id);
    expect(await parcel(id)).toMatchObject({ status: ParcelStatus.arrived_at_transit_point, custody: 'HANDOVER', currentTransitPointId: net.stations.juja });
    await s.trips.depart(trip, net.drivers.peter.id);
    await s.trips.arrive(trip, net.drivers.peter.id, net.stations.nairobi);
    await s.trips.complete(trip, net.drivers.peter.id);
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip } })).status).toBe(TripStatus.CLOSED);
    expect((await parcel(id)).status).toBe(ParcelStatus.arrived_at_transit_point);
  });

  it('batch verification: one missing parcel does not block the others, and re-submission is harmless', async () => {
    const trip = await h.openTrip('peter', 'meruNairobi', 'meru');
    const ids = [await book('meru', 'juja'), await book('meru', 'juja'), await book('meru', 'juja')];
    for (const id of ids) { await s.journey.confirmAtOrigin(id, h.officer('meru')); await h.acceptAndCollect(id, 'peter'); }
    await s.trips.startTrip(trip, net.drivers.peter.id);
    await s.trips.arrive(trip, net.drivers.peter.id, net.stations.juja);
    await s.trips.drop(trip, net.drivers.peter.id);
    const items = [{ parcelId: ids[0], outcome: 'VERIFIED' as const }, { parcelId: ids[1], outcome: 'VERIFIED' as const }, { parcelId: ids[2], outcome: 'MISSING' as const }];
    const result = await s.verification.verify(h.officer('juja'), { transitPointId: net.stations.juja, items });
    expect(result.summary).toEqual({ VERIFIED: 2, MISSING: 1 });
    expect((await parcel(ids[0])).status).toBe(ParcelStatus.at_destination);
    expect(await parcel(ids[2])).toMatchObject({ status: ParcelStatus.tampering_alert, custody: 'UNKNOWN' });
    const again = await s.verification.verify(h.officer('juja'), { transitPointId: net.stations.juja, items });
    expect(again.results.map((item) => item.result)).toEqual(['ALREADY_VERIFIED', 'ALREADY_VERIFIED', 'ALREADY_VERIFIED']);
    const alert = await prisma.tamperAlert.findFirstOrThrow({ where: { parcelId: ids[2], type: 'PARCEL_MISSING' } });
    await expect(s.journey.resolveException(alert.id, h.officer('meru'), { status: AlertStatus.RESOLVED })).rejects.toBeInstanceOf(NotFoundException);
    await s.journey.resolveException(alert.id, h.officer('juja'), { status: AlertStatus.RESOLVED, outcome: 'Found behind the counter', action: 'CONTINUE' });
    expect(await parcel(ids[2])).toMatchObject({ status: ParcelStatus.at_destination, custody: 'STATION' });
  });

  it('a damaged parcel is held; resolving the exception resumes its journey onto the next leg', async () => {
    const trip = await h.openTrip('peter', 'meruNairobi', 'meru');
    await h.openTrip('grace', 'nairobiKiambu', 'nairobi');
    const id = await book('meru', 'kiambu');
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    await h.acceptAndCollect(id, 'peter');
    await s.trips.startTrip(trip, net.drivers.peter.id);
    await s.trips.arrive(trip, net.drivers.peter.id, net.stations.nairobi);
    await s.trips.complete(trip, net.drivers.peter.id);
    await s.verification.verify(h.officer('nairobi'), { transitPointId: net.stations.nairobi, items: [{ parcelId: id, outcome: 'DAMAGED', notes: 'Wet corner' }] });
    expect(await parcel(id)).toMatchObject({ status: ParcelStatus.tampering_alert, custody: 'STATION' });
    expect(await prisma.parcelAssignment.count({ where: { parcelId: id, driverId: net.drivers.grace.id } })).toBe(0);
    const alert = await prisma.tamperAlert.findFirstOrThrow({ where: { parcelId: id, type: 'PARCEL_DAMAGED' } });
    await s.journey.resolveException(alert.id, h.officer('nairobi'), { status: AlertStatus.RESOLVED, outcome: 'Contents intact after inspection' });
    expect((await parcel(id)).status).toBe(ParcelStatus.at_transit_point);
    expect((await h.offer(id)).driverId).toBe(net.drivers.grace.id);
  });

  it('an unexpected parcel at a station raises an exception and is never received automatically', async () => {
    const id = await book('meru', 'nairobi');
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    const result = await s.verification.verify(h.officer('juja'), { transitPointId: net.stations.juja, items: [{ parcelId: id, outcome: 'VERIFIED' }] });
    expect(result.results[0].result).toBe('UNEXPECTED');
    expect(await parcel(id)).toMatchObject({ status: ParcelStatus.at_origin_transit_point, currentTransitPointId: net.stations.meru });
    expect(await prisma.tamperAlert.count({ where: { parcelId: id, type: 'UNEXPECTED_PARCEL', transitPointId: net.stations.juja } })).toBe(1);
  });

  it('locker requested but full falls back to the counter; after 12 hours a freed locker is used; otherwise flagged overdue once', async () => {
    const trip = await h.openTrip('peter', 'meruNairobi', 'meru');
    const a = await book('meru', 'juja', 1, 'SMART_LOCKER');
    const b = await book('meru', 'juja', 1, 'SMART_LOCKER');
    const c = await book('meru', 'juja', 5, 'STATION_COLLECTION');
    for (const id of [a, b, c]) { await s.journey.confirmAtOrigin(id, h.officer('meru')); await h.acceptAndCollect(id, 'peter'); }
    await s.trips.startTrip(trip, net.drivers.peter.id);
    await s.trips.arrive(trip, net.drivers.peter.id, net.stations.juja);
    await s.trips.drop(trip, net.drivers.peter.id);
    await s.verification.verify(h.officer('juja'), { transitPointId: net.stations.juja, items: [a, b, c].map((parcelId) => ({ parcelId, outcome: 'VERIFIED' as const })) });
    expect((await parcel(a)).status).toBe(ParcelStatus.locker_assigned);
    expect((await parcel(b)).status).toBe(ParcelStatus.at_destination);
    expect(await prisma.lockerRequest.findFirstOrThrow({ where: { parcelId: b } })).toMatchObject({ status: 'UNAVAILABLE' });
    expect(await prisma.notification.count({ where: { parcelId: b, title: 'Ready for station collection' } })).toBeGreaterThan(0);

    await prisma.parcel.updateMany({ where: { id: { in: [b, c] } }, data: { collectionDeadlineAt: new Date(Date.now() - 60_000) } });
    await s.collection.collectionSweep();
    await s.collection.collectionSweep();
    expect(await prisma.tamperAlert.count({ where: { parcelId: { in: [b, c] }, type: 'COLLECTION_OVERDUE' } })).toBe(2);
    expect((await parcel(b)).status).toBe(ParcelStatus.at_destination);

    const reservation = await prisma.lockerAssignment.findFirstOrThrow({ where: { parcelId: a } });
    await s.collection.confirmPlaced(reservation.id, h.officer('juja'));
    await s.collection.collectFromLocker(reservation.id, await codeFor(net.customers.brian.id, a), { id: net.customers.brian.id, role: UserRole.CUSTOMER });
    expect(await parcel(a)).toMatchObject({ status: ParcelStatus.delivered, custody: 'RECIPIENT' });
    expect((await parcel(b)).status).toBe(ParcelStatus.locker_assigned);
    expect((await parcel(c)).status).toBe(ParcelStatus.at_destination);
    await expect(s.collection.counterHandover(c, { id: net.customers.brian.id, role: UserRole.CUSTOMER })).rejects.toThrow('12-hour');
    await s.collection.counterHandover(c, h.officer('juja'));
    expect((await parcel(c)).status).toBe(ParcelStatus.delivered);
    expect(await prisma.tamperAlert.count({ where: { parcelId: c, type: 'COLLECTION_OVERDUE', status: AlertStatus.RESOLVED } })).toBe(1);
  });

  it('a wrong locker code is refused and the code is single-use', async () => {
    const trip = await h.openTrip('grace', 'nairobiKiambu', 'nairobi');
    const id = await h.book('alice', { to: 'brian', from: 'nairobi', dest: 'kiambu', weight: 1, method: 'SMART_LOCKER', description: 'locker' });
    await s.journey.confirmAtOrigin(id, h.officer('nairobi'));
    await h.acceptAndCollect(id, 'grace');
    await s.trips.startTrip(trip, net.drivers.grace.id);
    await s.trips.arrive(trip, net.drivers.grace.id, net.stations.kiambu);
    await s.trips.complete(trip, net.drivers.grace.id);
    await s.verification.verify(h.officer('kiambu'), { transitPointId: net.stations.kiambu, items: [{ parcelId: id, outcome: 'VERIFIED' }] });
    const reservation = await prisma.lockerAssignment.findFirstOrThrow({ where: { parcelId: id } });
    await expect(s.collection.collectFromLocker(reservation.id, '000000')).rejects.toBeInstanceOf(NotFoundException);
    await s.collection.confirmPlaced(reservation.id, h.officer('kiambu'));
    const code = await codeFor(net.customers.brian.id, id);
    await expect(s.collection.collectFromLocker(reservation.id, code === '111111' ? '222222' : '111111')).rejects.toBeInstanceOf(BadRequestException);
    const trackingNumber = (await parcel(id)).trackingNumber;
    await s.collection.collectFromLockerByTracking(trackingNumber, code);
    await expect(s.collection.collectFromLockerByTracking(trackingNumber, code)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the sender may change route details before hand-over only', async () => {
    const id = await book('meru', 'juja');
    const updated = await s.parcels.update(id, { destinationTransitPointId: net.stations.kiambu, weight: 7, collectionMethod: 'SMART_LOCKER' }, net.customers.alice.id, 'CUSTOMER');
    expect(updated).toMatchObject({ deliveryAddress: 'Kiambu', weight: 7, deliveryMethod: 'SMART_LOCKER' });
    await expect(s.parcels.update(id, { weight: 9 }, net.customers.brian.id, 'CUSTOMER')).rejects.toBeInstanceOf(ForbiddenException);
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    expect((await legs(id)).map((leg) => leg.toTransitPointId)).toEqual([net.stations.nairobi, net.stations.kiambu]);
    await expect(s.parcels.update(id, { destinationTransitPointId: net.stations.juja }, net.customers.alice.id, 'CUSTOMER')).rejects.toThrow('locked');
    await s.parcels.update(id, { description: 'Still editable' }, net.customers.alice.id, 'CUSTOMER');
  });

  it('bookings with no route connection are refused with NO_ROUTE_AVAILABLE', async () => {
    await prisma.transitPoint.create({ data: { id: 'scn-tp-lodwar', name: 'Lodwar', latitude: 3.1191, longitude: 35.5973 } });
    await expect(s.parcels.create({ recipientName: 'Brian', recipientEmail: net.customers.brian.email, recipientPhone: '0733000002', pickupTransitPointId: net.stations.meru, destinationTransitPointId: 'scn-tp-lodwar', weight: 1 } as never, net.customers.alice.id, 'CUSTOMER'))
      .rejects.toThrow('NO_ROUTE_AVAILABLE');
    await expect(s.journey.planPreview(net.stations.meru, 'scn-tp-lodwar')).rejects.toThrow('NO_ROUTE_AVAILABLE');
  });

  it('a deactivated route blocks unstarted journeys and flags started ones; the officer re-plans once it returns', async () => {
    const actor = await admin();
    const waiting = await book('meru', 'juja');
    await s.journey.confirmAtOrigin(waiting, h.officer('meru'));
    const trip = await h.openTrip('peter', 'meruNairobi', 'meru');
    const started = await book('meru', 'kiambu');
    await s.journey.confirmAtOrigin(started, h.officer('meru'));
    await h.acceptAndCollect(started, 'peter');
    await h.acceptAndCollect(waiting, 'peter');
    await s.trips.returnToStation(trip, net.drivers.peter.id, [(await active(waiting))!.id]);
    await s.verification.verify(h.officer('meru'), { transitPointId: net.stations.meru, items: [{ parcelId: waiting, outcome: 'VERIFIED' }] });
    await s.trips.startTrip(trip, net.drivers.peter.id);

    await s.operations.updateRoute(net.routes.nairobiKiambu, { active: false }, actor.id);
    expect(await prisma.tamperAlert.count({ where: { parcelId: started, type: 'ROUTE_UNAVAILABLE' } })).toBe(1);
    await s.operations.updateRoute(net.routes.meruNairobi, { active: false }, actor.id);
    expect(await parcel(waiting)).toMatchObject({ status: ParcelStatus.at_origin_transit_point, custody: 'STATION' });
    expect(await prisma.tamperAlert.count({ where: { parcelId: waiting, type: 'ROUTE_UNAVAILABLE' } })).toBe(1);

    await s.trips.arrive(trip, net.drivers.peter.id, net.stations.nairobi);
    await s.trips.complete(trip, net.drivers.peter.id);
    await s.verification.verify(h.officer('nairobi'), { transitPointId: net.stations.nairobi, items: [{ parcelId: started, outcome: 'VERIFIED' }] });
    expect((await legs(started)).map((leg) => leg.status)).toEqual([ParcelLegStatus.COMPLETED, ParcelLegStatus.EXCEPTION]);

    await s.operations.updateRoute(net.routes.nairobiKiambu, { active: true }, actor.id);
    await s.operations.updateRoute(net.routes.meruNairobi, { active: true }, actor.id);
    await h.openTrip('grace', 'nairobiKiambu', 'nairobi');
    await s.journey.replan(started, h.officer('nairobi'), { reason: 'Kiambu route back in service' });
    expect((await h.offer(started)).driverId).toBe(net.drivers.grace.id);
    await expect(s.journey.replan(waiting, h.officer('nairobi'), { reason: 'not my station' })).rejects.toBeInstanceOf(NotFoundException);
    await s.journey.replan(waiting, h.officer('meru'), { reason: 'Meru route back in service' });
    expect((await legs(waiting)).filter((leg) => leg.status === ParcelLegStatus.AWAITING_DRIVER || leg.status === ParcelLegStatus.DRIVER_ASSIGNED)).toHaveLength(1);
  });

  it('a trip with collected parcels cannot be cancelled until they are handed back; handing back returns the leg to the queue', async () => {
    const johnTrip = await h.openTrip('john', 'meruNairobi', 'meru');
    await h.openTrip('mary', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi', 10);
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    await h.acceptAndCollect(id, 'john');
    await expect(s.trips.cancel(johnTrip, { id: net.drivers.john.id, role: UserRole.DRIVER }, 'Sick')).rejects.toBeInstanceOf(ConflictException);
    await s.trips.returnToStation(johnTrip, net.drivers.john.id);
    await s.verification.verify(h.officer('meru'), { transitPointId: net.stations.meru, items: [{ parcelId: id, outcome: 'VERIFIED' }] });
    expect(await parcel(id)).toMatchObject({ status: ParcelStatus.at_origin_transit_point, custody: 'STATION' });
    expect((await h.offer(id)).driverId).toBe(net.drivers.mary.id);
    await s.trips.cancel(johnTrip, { id: net.drivers.john.id, role: UserRole.DRIVER }, 'Sick');
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: johnTrip } })).status).toBe(TripStatus.CANCELLED);
  });

  it('a driver who fails after collecting keeps custody until a station receives the parcel; the journey is then re-planned', async () => {
    const actor = await admin();
    const peterTrip = await h.openTrip('peter', 'meruNairobi', 'meru');
    await h.openTrip('john', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi', 10);
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    await h.acceptAndCollect(id, 'peter');
    await s.trips.startTrip(peterTrip, net.drivers.peter.id);
    await s.trips.arrive(peterTrip, net.drivers.peter.id, net.stations.chuka);
    await expect(s.trips.custodyException(peterTrip, h.officer('meru'), 'Vehicle breakdown')).rejects.toBeInstanceOf(NotFoundException);
    await s.trips.custodyException(peterTrip, { id: actor.id, role: UserRole.ADMIN }, 'Vehicle breakdown near Chuka');
    expect(await parcel(id)).toMatchObject({ status: ParcelStatus.in_transit, custody: 'DRIVER' });
    await s.dispatch.retryWaitingLegs();
    expect(await prisma.parcelAssignment.count({ where: { parcelId: id, driverId: net.drivers.john.id } })).toBe(0);
    await s.verification.verify(h.officer('chuka'), { transitPointId: net.stations.chuka, items: [{ parcelId: id, outcome: 'VERIFIED' }] });
    expect(await parcel(id)).toMatchObject({ custody: 'STATION', currentTransitPointId: net.stations.chuka });
    const current = (await legs(id)).find((leg) => leg.status === ParcelLegStatus.DRIVER_ASSIGNED)!;
    expect(current.fromTransitPointId).toBe(net.stations.chuka);
    expect((await h.offer(id)).driverId).toBe(net.drivers.john.id);
    expect(await prisma.tamperAlert.count({ where: { parcelId: id, type: 'CUSTODY_EXCEPTION', status: AlertStatus.RESOLVED } })).toBe(1);
  });

  it('a parcel heavier than every vehicle serving the route is not assigned', async () => {
    await h.openTrip('mary', 'thikaNyeri', 'thika');
    const id = await book('thika', 'nyeri', 400);
    await s.journey.confirmAtOrigin(id, h.officer('thika'));
    expect((await legs(id))[0]).toMatchObject({ status: ParcelLegStatus.AWAITING_DRIVER, noDriverReason: 'PARCEL_EXCEEDS_ALL_VEHICLES' });
  });

  it('staff can correct the weight after confirmation; the offer is re-evaluated', async () => {
    await h.openTrip('mary', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi', 100);
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    expect((await h.offer(id)).driverId).toBe(net.drivers.mary.id);
    await s.journey.correctWeight(id, 500, 'Weighed on the station scale', h.officer('meru'));
    expect((await legs(id))[0]).toMatchObject({ status: ParcelLegStatus.AWAITING_DRIVER, noDriverReason: 'INSUFFICIENT_CAPACITY' });
  });

  it('a pickup and a drop-off at the same stop are shown separately', async () => {
    const trip = await h.openTrip('peter', 'meruNairobi', 'meru');
    const toChuka = await book('meru', 'chuka');
    await s.journey.confirmAtOrigin(toChuka, h.officer('meru'));
    await h.acceptAndCollect(toChuka, 'peter');
    await s.trips.startTrip(trip, net.drivers.peter.id);
    const fromChuka = await book('chuka', 'juja');
    await s.journey.confirmAtOrigin(fromChuka, h.officer('chuka'));
    await s.dispatch.accept((await h.offer(fromChuka)).id, net.drivers.peter.id);
    const workspace = await s.trips.arrive(trip, net.drivers.peter.id, net.stations.chuka);
    const chuka = workspace.trip.stops.find((stop: any) => stop.name === 'Chuka');
    expect(chuka).toMatchObject({ state: 'CURRENT', operations: ['PICKUP_AND_DROPOFF'], pickupCount: 1, dropoffCount: 1 });
    expect(workspace.trip.stops.find((stop: any) => stop.name === 'Thika')).toMatchObject({ active: false });
    await s.trips.drop(trip, net.drivers.peter.id);
    await s.trips.collect((await h.offer(fromChuka)).id, net.drivers.peter.id);
    const after = await s.trips.workspace(net.drivers.peter.id);
    expect(after.trip.stops.find((stop: any) => stop.name === 'Juja')).toMatchObject({ active: true, dropoffCount: 1 });
  });

  it('role and station boundaries hold on the server', async () => {
    const trip = await h.openTrip('peter', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi');
    await expect(s.journey.confirmAtOrigin(id, h.officer('chuka'))).rejects.toBeInstanceOf(NotFoundException);
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    const offer = await h.offer(id);
    await expect(s.dispatch.accept(offer.id, net.drivers.john.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.trips.startTrip(trip, net.drivers.john.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.trips.openTrip(net.drivers.grace.id, { routeId: net.routes.meruNairobi, startTransitPointId: net.stations.meru })).rejects.toThrow('approved routes');
    await expect(s.trips.openTrip(net.drivers.peter.id, { routeId: net.routes.meruNairobi, startTransitPointId: net.stations.chuka })).rejects.toThrow();
    await expect(s.journey.cancelParcel(id, { id: net.customers.brian.id, role: UserRole.CUSTOMER }, 'not mine')).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.journey.cancelParcel(id, { id: net.customers.alice.id, role: UserRole.CUSTOMER }, 'changed mind')).rejects.toBeInstanceOf(BadRequestException);
    await s.journey.cancelParcel(id, h.officer('meru'), 'Sender withdrew at the counter');
    expect(await prisma.parcelAssignment.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({ status: AssignmentStatus.CANCELLED });
  });

  it('an unconfirmed booking expires after 24 hours', async () => {
    const id = await book('meru', 'nairobi');
    await prisma.parcel.update({ where: { id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    const sweeps = new WorkflowSweepsService(s.ctx, s.dispatch, s.collection);
    expect(await sweeps.expireUnconfirmed()).toBe(1);
    expect((await parcel(id)).status).toBe(ParcelStatus.cancelled);
  });
});

describe('Part 3 — rerouting (journey re-plan) across every dashboard', () => {
  let h: ReturnType<typeof scenarioHelpers>;
  beforeEach(async () => {
    await wipe();
    net = await buildScenarioNetwork(prisma);
    h = scenarioHelpers(s, net);
    s.events.length = 0;
  });
  const book = (from: keyof typeof STATIONS, dest: keyof typeof STATIONS, weight = 5, method: 'STATION_COLLECTION' | 'SMART_LOCKER' = 'STATION_COLLECTION') =>
    h.book('alice', { to: 'brian', from, dest, weight, method, description: `${from} → ${dest}` });
  const asAdmin = async () => ({ id: (await admin()).id, role: UserRole.ADMIN });
  const openLegs = async (parcelId: string) => (await legs(parcelId)).filter((leg) => leg.status !== ParcelLegStatus.CANCELLED && leg.status !== ParcelLegStatus.COMPLETED);
  const emitted = (event: string, parcelId: string) => s.events.filter((item) => item.event === event && (item.payload as any).parcelId === parcelId);
  const audience = (items: typeof s.events) => ({
    users: items.flatMap((item) => (item.audience as any).userIds ?? []),
    stations: items.flatMap((item) => (item.audience as any).transitPointIds ?? []),
  });

  it('R1 an officer re-plan withdraws the driver offer, tells the driver, refreshes every dashboard and re-assigns', async () => {
    await h.openTrip('peter', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi');
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    const first = await h.offer(id);
    expect(first.driverId).toBe(net.drivers.peter.id);
    s.events.length = 0;

    const result = await s.journey.replan(id, h.officer('meru'), { reason: 'Driver vehicle changed' });
    expect(result.settlement.kind).toBe('REPLANNED');
    expect(result.message).toMatch(/re-planned/);

    // Driver dashboard: offer withdrawn, notified, realtime event addressed to the driver.
    expect((await prisma.parcelAssignment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(AssignmentStatus.CANCELLED);
    expect(await prisma.notification.count({ where: { userId: net.drivers.peter.id, parcelId: id, title: 'Assignment withdrawn' } })).toBe(1);
    expect(audience(emitted('assignmentUpdate', id)).users).toContain(net.drivers.peter.id);
    // Station, customer and admin dashboards: parcel update to origin + destination stations and both parties.
    const update = audience(emitted('parcelStatusUpdate', id));
    expect(update.stations).toEqual(expect.arrayContaining([net.stations.meru, net.stations.nairobi]));
    expect(update.users).toEqual(expect.arrayContaining([net.customers.alice.id, net.customers.brian.id]));
    // Journey continues: exactly one live leg with a fresh offer, and history/audit record the re-plan.
    expect(await openLegs(id)).toHaveLength(1);
    expect((await h.offer(id)).id).not.toBe(first.id);
    expect(await prisma.parcelStatusHistory.count({ where: { parcelId: id, notes: { contains: 'Journey re-planned' } } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: 'JOURNEY_REPLANNED' } })).toBe(1);
  });

  it('R2 only an admin may change the destination; the new journey, addresses, notices and stations all follow', async () => {
    await h.openTrip('peter', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi');
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    await expect(s.journey.replan(id, h.officer('meru'), { reason: 'Recipient moved', destinationTransitPointId: net.stations.kiambu })).rejects.toThrow('Only an administrator');
    s.events.length = 0;

    const result = await s.journey.replan(id, await asAdmin(), { reason: 'Recipient moved to Kiambu', destinationTransitPointId: net.stations.kiambu });
    expect(result.message).toContain('Kiambu');
    expect(await parcel(id)).toMatchObject({ destinationTransitPointId: net.stations.kiambu, deliveryAddress: 'Kiambu', custody: 'STATION', currentTransitPointId: net.stations.meru });
    expect((await openLegs(id)).map((leg) => [leg.fromTransitPointId, leg.toTransitPointId])).toEqual([[net.stations.meru, net.stations.nairobi], [net.stations.nairobi, net.stations.kiambu]]);
    expect(await prisma.parcelStatusHistory.count({ where: { parcelId: id, notes: { contains: 'Destination changed from Nairobi to Kiambu' } } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: 'PARCEL_DESTINATION_CORRECTED' } })).toBe(1);
    for (const user of [net.customers.alice.id, net.customers.brian.id, net.officers.nairobi.id, net.officers.kiambu.id]) {
      expect(await prisma.notification.count({ where: { userId: user, parcelId: id, title: 'Destination changed' } })).toBe(1);
    }
    // Old destination (Nairobi) and new one (Kiambu) both refresh.
    expect(audience(emitted('parcelStatusUpdate', id)).stations).toEqual(expect.arrayContaining([net.stations.meru, net.stations.nairobi, net.stations.kiambu]));
    // Customer tracking shows the new destination.
    const view = await s.journey.journeyView(id, 'customer');
    expect(view.destination).toBe('Kiambu');
    expect(view.stops.at(-1)).toMatchObject({ name: 'Kiambu', role: 'DESTINATION' });
  });

  it('R3 a re-plan to a destination no route reaches is refused and changes nothing', async () => {
    await prisma.transitPoint.create({ data: { id: 'scn-tp-lodwar', name: 'Lodwar', latitude: 3.1191, longitude: 35.5973 } });
    await h.openTrip('peter', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi');
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    const before = { legs: await openLegs(id), offer: await h.offer(id) };

    await expect(s.journey.replan(id, await asAdmin(), { reason: 'Send it to Lodwar', destinationTransitPointId: 'scn-tp-lodwar' })).rejects.toThrow('NO_ROUTE_AVAILABLE');
    expect(await parcel(id)).toMatchObject({ destinationTransitPointId: net.stations.nairobi, deliveryAddress: 'Nairobi' });
    expect((await openLegs(id)).map((leg) => leg.id)).toEqual(before.legs.map((leg) => leg.id));
    expect((await h.offer(id)).id).toBe(before.offer.id);
    expect(await prisma.tamperAlert.count({ where: { parcelId: id } })).toBe(0);
  });

  it('R4 input and custody rules: short reason, wrong station, inactive destination, parcel with a driver, closed parcel', async () => {
    await h.openTrip('peter', 'meruNairobi', 'meru');
    const id = await book('meru', 'nairobi');
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    await expect(s.journey.replan(id, h.officer('meru'), { reason: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.journey.replan(id, h.officer('chuka'), { reason: 'Not my parcel' })).rejects.toBeInstanceOf(NotFoundException);
    await prisma.transitPoint.update({ where: { id: net.stations.kiambu }, data: { active: false } });
    await expect(s.journey.replan(id, await asAdmin(), { reason: 'Inactive destination', destinationTransitPointId: net.stations.kiambu })).rejects.toThrow('not active');
    await h.acceptAndCollect(id, 'peter');
    // With the driver holding it no station does: the officer is refused, and even an admin cannot re-plan.
    await expect(s.journey.replan(id, h.officer('meru'), { reason: 'Driver already has it' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.journey.replan(id, await asAdmin(), { reason: 'Driver already has it' })).rejects.toThrow('while a station holds the parcel');

    const cancelled = await book('meru', 'juja');
    await s.journey.confirmAtOrigin(cancelled, h.officer('meru'));
    await s.journey.cancelParcel(cancelled, h.officer('meru'), 'Sender asked');
    await expect(s.journey.replan(cancelled, h.officer('meru'), { reason: 'Too late now' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('R5 rerouting to the station already holding the parcel makes it ready for collection there', async () => {
    const id = await book('meru', 'nairobi');
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    const result = await s.journey.replan(id, await asAdmin(), { reason: 'Recipient will collect in Meru', destinationTransitPointId: net.stations.meru });
    expect(result.settlement.kind).toBe('FINAL');
    expect(result.message).toMatch(/ready for collection/);
    const p = await parcel(id);
    expect(p).toMatchObject({ status: ParcelStatus.at_destination, custody: 'STATION', destinationTransitPointId: net.stations.meru });
    expect(p.collectionDeadlineAt).toBeTruthy();
    expect(await openLegs(id)).toHaveLength(0);
  });

  it('R6 a smart-locker parcel gets a fresh locker request for its new destination', async () => {
    const id = await book('meru', 'nairobi', 5, 'SMART_LOCKER');
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    const before = await prisma.lockerRequest.findMany({ where: { parcelId: id } });
    expect(before.length).toBeGreaterThan(0);
    await s.journey.replan(id, await asAdmin(), { reason: 'Recipient moved to Kiambu', destinationTransitPointId: net.stations.kiambu });
    const requests = await prisma.lockerRequest.findMany({ where: { parcelId: id }, orderBy: { createdAt: 'asc' } });
    expect(requests.filter((item) => item.status === 'PENDING')).toHaveLength(1);
    expect(requests.find((item) => item.status === 'PENDING')!.stationId).toBeNull();
    expect(requests.filter((item) => before.some((old) => old.id === item.id)).every((item) => item.status === 'REJECTED')).toBe(true);
  });

  it('R7 resolving a route exception by re-planning keeps it open while no route exists, and closes it once one does', async () => {
    const actor = await asAdmin();
    const id = await book('meru', 'nairobi');
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    await s.operations.updateRoute(net.routes.meruNairobi, { active: false }, actor.id);
    const alert = await prisma.tamperAlert.findFirstOrThrow({ where: { parcelId: id, type: 'ROUTE_UNAVAILABLE' } });

    await expect(s.journey.resolveException(alert.id, h.officer('meru'), { status: AlertStatus.RESOLVED, outcome: 'Trying again now', action: 'REPLAN' })).rejects.toThrow('NO_ROUTE_AVAILABLE');
    expect((await prisma.tamperAlert.findUniqueOrThrow({ where: { id: alert.id } })).status).not.toBe(AlertStatus.RESOLVED);

    await s.operations.updateRoute(net.routes.meruNairobi, { active: true }, actor.id);
    const resolved = await s.journey.resolveException(alert.id, h.officer('meru'), { status: AlertStatus.RESOLVED, outcome: 'Route is back in service', action: 'REPLAN' });
    expect(resolved).toMatchObject({ status: AlertStatus.RESOLVED, outcome: 'Route is back in service' });
    expect((await openLegs(id)).map((leg) => leg.status)).toEqual([expect.stringMatching(/AWAITING_DRIVER|DRIVER_ASSIGNED/)]);
    const queues = await s.queues.queues(h.officer('meru'));
    expect(queues.queues!.exceptions.map((item: any) => item.parcel.id)).not.toContain(id);
  });

  it('R8 a route deactivated under a waiting transfer withdraws the connecting driver and tells them', async () => {
    const actor = await asAdmin();
    const trip = await h.openTrip('peter', 'meruNairobi', 'meru');
    const id = await book('meru', 'kiambu');
    await s.journey.confirmAtOrigin(id, h.officer('meru'));
    await h.acceptAndCollect(id, 'peter');
    await s.trips.startTrip(trip, net.drivers.peter.id);
    await s.trips.arrive(trip, net.drivers.peter.id, net.stations.nairobi);
    await s.trips.complete(trip, net.drivers.peter.id);
    await h.openTrip('grace', 'nairobiKiambu', 'nairobi');
    await s.verification.verify(h.officer('nairobi'), { transitPointId: net.stations.nairobi, items: [{ parcelId: id, outcome: 'VERIFIED' }] });
    const graceOffer = await h.offer(id);
    expect(graceOffer.driverId).toBe(net.drivers.grace.id);
    s.events.length = 0;

    await s.operations.updateRoute(net.routes.nairobiKiambu, { active: false }, actor.id);
    expect((await prisma.parcelAssignment.findUniqueOrThrow({ where: { id: graceOffer.id } })).status).toBe(AssignmentStatus.CANCELLED);
    expect(await prisma.notification.count({ where: { userId: net.drivers.grace.id, parcelId: id, title: 'Assignment withdrawn' } })).toBe(1);
    expect(audience(emitted('assignmentUpdate', id)).users).toContain(net.drivers.grace.id);
    expect(audience(emitted('parcelStatusUpdate', id)).stations).toContain(net.stations.nairobi);
    expect(await prisma.tamperAlert.count({ where: { parcelId: id, type: 'ROUTE_UNAVAILABLE', status: { not: AlertStatus.RESOLVED } } })).toBe(1);

    // Once the route returns, the Nairobi officer re-plans and Grace is offered it again.
    await s.operations.updateRoute(net.routes.nairobiKiambu, { active: true }, actor.id);
    await s.journey.replan(id, h.officer('nairobi'), { reason: 'Kiambu route back in service' });
    expect((await h.offer(id)).driverId).toBe(net.drivers.grace.id);
    expect(await prisma.tamperAlert.count({ where: { parcelId: id, type: 'ROUTE_UNAVAILABLE', status: { not: AlertStatus.RESOLVED } } })).toBe(0);
  });

  it('R9 a sender changing the destination before hand-over refreshes the old and new stations', async () => {
    const id = await book('meru', 'nairobi');
    s.events.length = 0;
    await s.parcels.update(id, { destinationTransitPointId: net.stations.kiambu }, net.customers.alice.id, 'CUSTOMER');
    expect(await parcel(id)).toMatchObject({ destinationTransitPointId: net.stations.kiambu, deliveryAddress: 'Kiambu', status: ParcelStatus.awaiting_confirmation });
    const update = audience(emitted('parcelStatusUpdate', id));
    expect(update.stations).toEqual(expect.arrayContaining([net.stations.meru, net.stations.nairobi, net.stations.kiambu]));
    expect(update.users).toContain(net.customers.alice.id);
  });
});
