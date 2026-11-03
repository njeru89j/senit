/**
 * Seeds the operational delivery network: stations, two-way routes, one officer per station,
 * 40 smart lockers per station and ten drivers per route. No parcels are created — the network is
 * ready for real bookings.
 *
 *   npx prisma db seed            (or: npm run db:seed)
 *   npm run db:seed:verify        checks the resulting network
 *
 * The demonstration story (parcels mid-journey, exceptions, a locker code) is a separate seed:
 *   npm run db:seed:scenario
 */
import * as bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../src/database/prisma.service';
import {
  NETWORK_PASSWORD, ROUTES, RouteKey, STATIONS, StationKey, buildNetwork, driverEmail, officerEmail, resetNetwork, routeLengthKm, routeName, routeStops,
} from './network';

const ADMIN_EMAIL = 'sendit@gmail.com';
const ADMIN_DEFAULT_PASSWORD = 'Admin123';

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    // An administrator is needed to see everything; an existing account (and its password) is left alone.
    const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
    if (!admin) await prisma.user.create({ data: { email: ADMIN_EMAIL, password: await bcrypt.hash(ADMIN_DEFAULT_PASSWORD, 12), name: 'SendIT Administrator', role: UserRole.ADMIN } });

    console.log('Clearing the previously seeded network…');
    await resetNetwork(prisma);
    console.log('Building the network:');
    const network = await buildNetwork(prisma, (line) => console.log(`  • ${line}`));

    const routeKeys = Object.keys(ROUTES) as RouteKey[];
    const throughNairobi = routeKeys.filter((key) => routeStops(key).some(([stop]) => stop === 'nairobi'));
    console.log('\nRoutes (each runs in both directions):');
    for (const key of routeKeys) {
      const stops = routeStops(key).map(([stop]) => STATIONS[stop].name).join(' → ');
      console.log(`  ${routeName(key).padEnd(24)} ${String(routeLengthKm(key)).padStart(4)} km  ${stops}`);
    }

    const transfers = (Object.keys(STATIONS) as StationKey[])
      .map((key) => ({ name: STATIONS[key].name, routes: routeKeys.filter((route) => routeStops(route).some(([stop]) => stop === key)).length }))
      .filter((station) => station.routes > 1)
      .sort((a, b) => b.routes - a.routes);
    console.log(`\nHub: all ${throughNairobi.length} routes are spokes out of Nairobi, so no two routes share a station and a parcel between spokes transfers once.`);
    console.log(`Transfer stations: ${transfers.map((station) => `${station.name} (${station.routes} routes)`).join(', ')}`);

    console.log(`\nAccounts (password for every seeded account: ${NETWORK_PASSWORD})`);
    console.log(`  Admin              ${ADMIN_EMAIL}${admin ? ' (existing password unchanged)' : ` / ${ADMIN_DEFAULT_PASSWORD}`}`);
    console.log(`  Station officers   ${network.officers.length}: ${officerEmail('nairobi')}, ${officerEmail('meru')}, … one per station`);
    console.log(`  Drivers            ${network.drivers.length}: ${driverEmail(1)} … ${driverEmail(network.drivers.length)} (10 per route)`);
    console.log('\nNetwork seed complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
