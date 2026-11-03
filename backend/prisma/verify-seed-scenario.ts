/**
 * Verifies the seeded corridor scenario: every parcel sits in the state the story leaves it in, and the
 * separated records (legs, assignments, trips, custody, lockers, exceptions) agree with each other.
 */
import { PrismaClient } from '@prisma/client';
import { SCENARIO_EMAIL_DOMAIN } from './scenario/network';

const prisma = new PrismaClient();

async function main() {
  const failures: string[] = [];
  const check = (ok: unknown, message: string) => { if (!ok) failures.push(message); };
  const byDescription = async (prefix: string) => prisma.parcel.findFirst({ where: { description: { startsWith: prefix } }, include: { legs: { orderBy: { sequence: 'asc' }, include: { assignments: true } } } });

  const P1 = await byDescription('P1 ·');
  const P2 = await byDescription('P2 ·');
  const P3 = await byDescription('P3 ·');
  const P4 = await byDescription('P4 ·');
  const P5 = await byDescription('P5 ·');
  const P7 = await byDescription('P7 ·');
  const P8 = await byDescription('P8 ·');
  const P9 = await byDescription('P9 ·');
  check(P1?.status === 'in_locker' && P1.custody === 'LOCKER' && P1.legs.length === 2 && P1.legs.every((leg) => leg.status === 'COMPLETED'), 'P1 must be in a locker after two completed legs');
  check(P1 && new Set(P1.legs.flatMap((leg) => leg.assignments.filter((item) => item.status === 'COMPLETED').map((item) => item.driverId))).size === 2, 'P1 must have been carried by two different drivers');
  check(P2?.status === 'delivered' && P2.custody === 'RECIPIENT', 'P2 must be delivered to the recipient');
  check(P3?.status === 'at_destination' && P3.custody === 'STATION' && !!P3.collectionDeadlineAt, 'P3 must be ready for station collection with a deadline');
  check(P4?.status === 'at_origin_transit_point' && P4.legs[0]?.status === 'AWAITING_DRIVER' && !!P4.legs[0]?.noDriverReason, 'P4 must be waiting for a driver with a reason');
  check(P5?.legs[0]?.status === 'DRIVER_ASSIGNED' && P5.legs[0].assignments.some((item) => item.status === 'REJECTED') && P5.legs[0].assignments.some((item) => item.status === 'ASSIGNED' && !!item.acceptanceDeadline), 'P5 must show a rejection and a pending re-offer with a deadline');
  check(P7?.status === 'awaiting_confirmation' && P7.custody === 'SENDER' && P7.legs.length === 0, 'P7 must be awaiting hand-over with no frozen legs');
  check(P8?.status === 'tampering_alert' && P8.custody === 'UNKNOWN', 'P8 must be missing (custody unknown)');
  check(P9?.status === 'tampering_alert' && P9.custody === 'STATION', 'P9 must be held damaged at a station');
  const alerts = await prisma.tamperAlert.groupBy({ by: ['type'], where: { parcelId: { in: [P8?.id, P9?.id].filter(Boolean) as string[] }, status: 'OPEN' }, _count: true });
  check(alerts.some((row) => row.type === 'PARCEL_MISSING') && alerts.some((row) => row.type === 'PARCEL_DAMAGED'), 'missing and damaged exceptions must be open');

  // Cross-record invariants across every scenario parcel.
  const legsWithTwoActive = await prisma.$queryRaw<{ legId: string }[]>`
    SELECT "legId" FROM "parcel_assignments" WHERE "legId" IS NOT NULL AND "status" IN ('ASSIGNED','ACCEPTED','COLLECTED','DROPPED') GROUP BY "legId" HAVING COUNT(*) > 1`;
  check(!legsWithTwoActive.length, 'no leg may have two active assignments');
  const driverCustodyWithoutCarrier = await prisma.parcel.count({ where: { custody: 'DRIVER', legs: { none: { assignments: { some: { status: 'COLLECTED' } } } } } });
  check(!driverCustodyWithoutCarrier, 'every parcel in driver custody must have a collecting driver on record');
  const openTrips = await prisma.trip.groupBy({ by: ['driverId'], where: { status: { in: ['CREATED', 'IN_TRANSIT'] } }, _count: true });
  check(openTrips.every((row) => row._count === 1), 'a driver may have only one open trip');
  const scenarioUsers = await prisma.user.count({ where: { email: { endsWith: `@${SCENARIO_EMAIL_DOMAIN}` } } });
  check(scenarioUsers >= 22, `expected the scenario accounts, found ${scenarioUsers}`);

  if (failures.length) {
    console.error(`Scenario verification failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Scenario verification passed: parcels, legs, assignments, trips, custody, lockers and exceptions are consistent.');
}

main().finally(() => prisma.$disconnect());
