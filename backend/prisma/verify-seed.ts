import { ParcelStatus, PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const routeNames = ['Kisii-Nairobi', 'Nairobi-Meru', 'Mombasa-Nairobi', 'Nairobi-Kisumu', 'Nairobi-Eldoret', 'Nakuru-Kakamega', 'Nairobi-Nyeri', 'Kisumu-Busia', 'Meru-Embu', 'Nairobi-Garissa'];
  const routes = await prisma.route.findMany({ where: { name: { in: routeNames } } });
  const seededUsers = await prisma.user.count({ where: { OR: [{ email: 'sendit@gmail.com' }, { email: { endsWith: '@sendit.local' } }] } });
  const routePoints = await prisma.routeTransitPoint.groupBy({ by: ['routeId'], where: { routeId: { in: routes.map(route => route.id) } }, _count: true });
  const drivers = await prisma.user.findMany({ where: { role: UserRole.DRIVER, OR: [{ email: { endsWith: '@sendit.local' } }, { email: { in: ['kisii.driver@sendit.local', 'meru.driver@sendit.local'] } }] }, include: { driverProfile: true } });
  const routeDriverCounts = new Map(routes.map(route => [route.id, drivers.filter(driver => driver.driverProfile?.routesServed.includes(route.id)).length]));
  const parcelStatuses = await prisma.parcel.groupBy({ by: ['status'], where: { trackingNumber: { startsWith: 'SENDIT-SEED-' } }, _count: true });
  const bulkParcels = parcelStatuses.reduce((sum, row) => sum + row._count, 0);
  const requiredStatuses = [ParcelStatus.pending, ParcelStatus.assigned, ParcelStatus.picked_up, ParcelStatus.in_transit, ParcelStatus.delivered_to_recipient, ParcelStatus.delivered, ParcelStatus.completed, ParcelStatus.cancelled];
  const highVolumeUsers = await prisma.user.findMany({ where: { email: { in: ['customer01@sendit.local', 'customer02@sendit.local', 'customer06@sendit.local'] } }, select: { email: true, totalParcelsEverSent: true, totalParcelsReceived: true } });
  const seededForecasts = await prisma.demandForecast.count({ where: { model: 'seed-four-week-recency-weighted-v2' } });
  const deactivatedDriver = await prisma.user.findUnique({ where: { email: 'driver15@sendit.local' }, include: { driverProfile: true } });
  const activePoints = await prisma.transitPoint.findMany({ where: { active: true }, select: { id: true } });
  const officerAssignments = await prisma.transitPointOfficer.groupBy({ by: ['transitPointId'], _count: true });
  const assignedOfficerRows = await prisma.transitPointOfficer.findMany({ select: { officerId: true } });
  const failures = [
    seededUsers < 40 && `expected at least 40 seeded users, found ${seededUsers}`,
    routes.length !== 10 && `expected 10 seeded routes, found ${routes.length}`,
    routePoints.some(row => row._count < 3 || row._count > 5) && 'every seeded route must have 3-5 ordered transit points',
    drivers.length < 15 && `expected at least 15 seeded drivers, found ${drivers.length}`,
    [...routeDriverCounts.values()].some(count => count < 2) && 'every route must be covered by more than one driver',
    bulkParcels !== 200 && `expected 200 bulk parcels, found ${bulkParcels}`,
    requiredStatuses.some(status => !parcelStatuses.some(row => row.status === status && row._count > 0)) && 'every requested parcel status must be represented',
    !highVolumeUsers.some(user => user.totalParcelsEverSent >= 30) && 'a high-volume sender is required',
    !highVolumeUsers.some(user => user.totalParcelsReceived >= 50) && 'a high-volume recipient is required',
    seededForecasts < 8 && 'seeded demand forecasts are missing',
    (deactivatedDriver?.isActive !== false || deactivatedDriver.driverProfile?.approvalStatus !== 'DEACTIVATED') && 'deactivated driver state is missing',
    activePoints.some(point => !officerAssignments.some(row => row.transitPointId === point.id && row._count > 0)) && 'every transit point must have a nominated officer',
    new Set(assignedOfficerRows.map(row => row.officerId)).size !== assignedOfficerRows.length && 'an officer is assigned to more than one transit point',
  ].filter(Boolean);
  if (failures.length) throw new Error(failures.join('; '));
  console.log(JSON.stringify({ seededUsers, routes: routes.length, transitPointsPerRoute: routePoints.map(row => row._count), drivers: drivers.length, minimumDriversPerRoute: Math.min(...routeDriverCounts.values()), bulkParcels, parcelStatuses: Object.fromEntries(parcelStatuses.map(row => [row.status, row._count])), highVolumeUsers, seededForecasts, deactivatedDriver: deactivatedDriver?.email }, null, 2));
}

main().finally(() => prisma.$disconnect());
