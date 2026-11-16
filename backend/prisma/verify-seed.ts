/**
 * Checks the seeded operational network: stations, routes, officers, lockers, drivers, and that a
 * parcel can actually be routed between any two stations.
 *
 *   npm run db:seed:verify
 */
import { LockerSize, UserRole, VehicleType } from '@prisma/client';
import { PrismaService } from '../src/database/prisma.service';
import { RouteNetwork } from '../src/common/route-planner';
import { NETWORK_EMAIL_DOMAIN, ROUTES, RouteKey, STATIONS, StationKey, officerEmail, routeStops, stationId } from './network';

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const stationKeys = Object.keys(STATIONS) as StationKey[];
    const routeKeys = Object.keys(ROUTES) as RouteKey[];

    const points = await prisma.transitPoint.findMany({ where: { id: { startsWith: 'net-' } } });
    check('every station exists and is active', points.length === stationKeys.length && points.every((point) => point.active), `${points.length}/${stationKeys.length}`);

    const routes = await prisma.route.findMany({ where: { id: { startsWith: 'net-' } } });
    const memberships = await prisma.routeTransitPoint.findMany({ where: { routeId: { startsWith: 'net-' } }, orderBy: { sequence: 'asc' } });
    check('every route exists and is active', routes.length === routeKeys.length && routes.every((route) => route.active), `${routes.length}/${routeKeys.length}`);
    const stopCounts = routes.map((route) => memberships.filter((stop) => stop.routeId === route.id).length);
    check('each route has 3 to 5 stops', stopCounts.every((count) => count >= 3 && count <= 5), `stops per route: ${[...new Set(stopCounts)].sort().join(', ')}`);
    check('distances are recorded between stops', memberships.filter((stop) => stop.sequence > 1).every((stop) => (stop.distanceFromPreviousKm ?? 0) > 0));

    const officers = await prisma.user.findMany({ where: { role: UserRole.TRANSIT_OFFICER, email: { endsWith: `@${NETWORK_EMAIL_DOMAIN}` } } });
    const nominations = await prisma.transitPointOfficer.findMany({ where: { transitPointId: { startsWith: 'net-' } } });
    const stationsWithOfficer = new Set(nominations.map((row) => row.transitPointId));
    check('one officer per station', officers.length === stationKeys.length && stationsWithOfficer.size === stationKeys.length, `${officers.length} officers, ${stationsWithOfficer.size} stations covered`);
    check('officer emails follow <station>@sendit.com', officers.some((officer) => officer.email === officerEmail('meru')), officerEmail('meru'));

    const lockerStations = await prisma.lockerStation.findMany({ where: { id: { startsWith: 'net-' } } });
    const compartments = await prisma.lockerCompartment.groupBy({ by: ['stationId', 'size'], _count: { _all: true }, where: { stationId: { startsWith: 'net-' } } });
    const perStation = new Map<string, number>();
    for (const row of compartments) perStation.set(row.stationId, (perStation.get(row.stationId) ?? 0) + row._count._all);
    const sizes = new Set(compartments.map((row) => row.size));
    check('every station has a locker bank', lockerStations.length === stationKeys.length, `${lockerStations.length}/${stationKeys.length}`);
    check('40 lockers at every station', [...perStation.values()].every((count) => count === 40) && perStation.size === stationKeys.length, `total ${[...perStation.values()].reduce((a, b) => a + b, 0)}`);
    check('lockers come in four sizes', sizes.size === 4, [...sizes].join(', '));

    const drivers = await prisma.user.findMany({ where: { role: UserRole.DRIVER, email: { endsWith: `@${NETWORK_EMAIL_DOMAIN}` } }, include: { driverProfile: true } });
    check('ten drivers per route', drivers.length === routeKeys.length * 10, `${drivers.length} drivers`);
    const byRoute = new Map<string, typeof drivers>();
    for (const driver of drivers) {
      const route = driver.driverProfile?.routesServed[0] ?? 'none';
      byRoute.set(route, [...(byRoute.get(route) ?? []), driver]);
    }
    check('every route is staffed', byRoute.size === routeKeys.length && [...byRoute.values()].every((list) => list.length === 10), `${byRoute.size} routes staffed`);
    check('two motorcycles per route', [...byRoute.values()].every((list) => list.filter((driver) => driver.vehicleType === VehicleType.MOTORCYCLE).length === 2));
    check('every driver has a vehicle and capacity', drivers.every((driver) => driver.vehicleNumber && (driver.maxLoadKg ?? 0) > 0));
    check('driver vehicle numbers are unique', new Set(drivers.map((driver) => driver.vehicleNumber)).size === drivers.length);

    // Routing: the planner must find a journey between every pair of stations, in both directions.
    const network = new RouteNetwork(routes, memberships, points);
    const unreachable: string[] = [];
    let maxLegs = 0;
    for (const from of stationKeys) {
      for (const to of stationKeys) {
        if (from === to) continue;
        const plan = network.plan(stationId(from), stationId(to));
        if (!plan) unreachable.push(`${STATIONS[from].name} → ${STATIONS[to].name}`);
        else maxLegs = Math.max(maxLegs, plan.length);
      }
    }
    const pairs = stationKeys.length * (stationKeys.length - 1);
    check('a route exists between every pair of stations', unreachable.length === 0, unreachable.length ? `${unreachable.length} of ${pairs} unreachable: ${unreachable.slice(0, 3).join(', ')}…` : `${pairs} pairs, at most ${maxLegs} legs`);

    // Hub shape: every route is a spoke out of Nairobi and no station sits on two routes.
    check('every route starts at Nairobi', routeKeys.every((key) => routeStops(key)[0][0] === 'nairobi'));
    const onRoutes = new Map<StationKey, number>();
    for (const key of routeKeys) for (const [stop] of routeStops(key)) onRoutes.set(stop, (onRoutes.get(stop) ?? 0) + 1);
    const shared = [...onRoutes.entries()].filter(([stop, count]) => stop !== 'nairobi' && count > 1);
    check('routes do not overlap (no station on two routes)', shared.length === 0, shared.length ? shared.map(([stop, count]) => `${STATIONS[stop].name}×${count}`).join(', ') : `Nairobi is on all ${routeKeys.length}`);
    check('journeys between spokes need one transfer at most', maxLegs <= 2, `at most ${maxLegs} legs`);

    const crossCountry = network.plan(stationId('mombasa'), stationId('kisumu'));
    check('a cross-country journey transfers at Nairobi', !!crossCountry && crossCountry.length === 2 && crossCountry[0].toTransitPointId === stationId('nairobi'), crossCountry ? network.describe(crossCountry) : 'no plan');

    const sameSpoke = network.plan(stationId('ruiru'), stationId('thika'));
    check('journeys along one spoke stay on it', !!sameSpoke && sameSpoke.length === 1, sameSpoke ? network.describe(sameSpoke) : 'no plan');

    const officerAddresses = officers.filter((officer) => (officer.address ?? '').length > 20);
    check('every officer has a street address', officerAddresses.length === officers.length, officers[0]?.address ?? 'none');

    const failed = checks.filter((item) => !item.ok);
    for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
