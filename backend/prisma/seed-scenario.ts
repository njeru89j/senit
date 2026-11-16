/**
 * Seeds the "day on the corridor" scenario by playing it through the real workflow services, so every
 * record (journeys, assignments, trips, custody, lockers, exceptions, history, notifications) is exactly
 * what the application produces. Re-running replaces the previous scenario data and nothing else.
 *
 *   npx prisma db seed            (or: npm run db:seed)
 *   npm run db:seed:verify        checks the resulting state
 */
import * as bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../src/database/prisma.service';
import { buildScenarioNetwork, resetScenario, SCENARIO_PASSWORD, STATIONS, DRIVERS, CUSTOMERS } from './scenario/network';
import { buildWorkflowServices } from './scenario/services';
import { runCorridorStory } from './scenario/story';

const ADMIN_EMAIL = 'sendit@gmail.com';
const ADMIN_DEFAULT_PASSWORD = 'Admin123';

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    // An administrator is needed to see everything; an existing account (and its password) is left alone.
    const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
    if (!admin) await prisma.user.create({ data: { email: ADMIN_EMAIL, password: await bcrypt.hash(ADMIN_DEFAULT_PASSWORD, 12), name: 'SendIT Administrator', role: UserRole.ADMIN } });

    console.log('Resetting previous scenario data…');
    await resetScenario(prisma);
    console.log('Building the scenario network (13 stations, 4 two-way routes, officers, drivers, customers, lockers)…');
    const network = await buildScenarioNetwork(prisma);
    const services = buildWorkflowServices(prisma);
    console.log('Playing the corridor story through the workflow services:');
    const story = await runCorridorStory(services, network, (line) => console.log(`  • ${line}`));

    const parcels = await prisma.parcel.findMany({ where: { id: { in: Object.values(story.parcels) } }, select: { id: true, trackingNumber: true, status: true } });
    const code = await prisma.notification.findFirst({ where: { userId: network.customers.brian.id, parcelId: story.parcels.P1, title: 'Smart locker collection code' }, orderBy: { createdAt: 'desc' } });
    const lockerCode = code?.message.match(/code (\d{6})/)?.[1];

    console.log('\nParcels:');
    for (const [key, id] of Object.entries(story.parcels)) {
      const parcel = parcels.find((item) => item.id === id);
      console.log(`  ${key}  ${parcel?.trackingNumber}  ${parcel?.status}`);
    }
    console.log(`\nAccounts (password for every scenario account: ${SCENARIO_PASSWORD})`);
    console.log(`  Admin              ${ADMIN_EMAIL}${admin ? ' (existing password unchanged)' : ` / ${ADMIN_DEFAULT_PASSWORD}`}`);
    console.log(`  Customers          ${Object.keys(CUSTOMERS).map((key) => network.customers[key as keyof typeof CUSTOMERS].email).join(', ')}`);
    console.log(`  Drivers            ${Object.keys(DRIVERS).map((key) => network.drivers[key as keyof typeof DRIVERS].email).join(', ')}`);
    console.log(`  Station officers   officer.<station>@scenario.sendit.local for ${Object.keys(STATIONS).join(', ')}`);
    if (lockerCode) console.log(`\nP1 is in Kiambu locker; Brian's collection code is ${lockerCode} (also in his notifications).`);
    console.log('\nScenario seed complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
