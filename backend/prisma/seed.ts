import { BatchStatus, DriverStatus, LockerStatus, ParcelStatus, PrismaClient, User, UserRole, VehicleType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { forecastWeeklyVolume } from '../src/common/forecast';

const prisma = new PrismaClient();
const demoPassword = 'Admin123';
const demoLockerCode = '246810';

async function seedOperationalVolume(password: string, base: { adminId: string; customerId: string; officerId: string; driverIds: string[]; routeIds: string[] }) {
  const customers: User[] = [];
  for (let index = 1; index <= 22; index++) {
    customers.push(await prisma.user.upsert({
      where: { email: `customer${index.toString().padStart(2, '0')}@sendit.local` },
      update: { password, isActive: true },
      create: { email: `customer${index.toString().padStart(2, '0')}@sendit.local`, password, name: `Seed Customer ${index.toString().padStart(2, '0')}`, phone: `071${index.toString().padStart(7, '0')}`, role: UserRole.CUSTOMER },
    }));
  }

  const drivers = [...base.driverIds];
  for (let index = 3; index <= 15; index++) {
    const deactivated = index === 15;
    const driver = await prisma.user.upsert({
      where: { email: `driver${index.toString().padStart(2, '0')}@sendit.local` },
      update: { password, role: UserRole.DRIVER, isActive: !deactivated, deletedAt: deactivated ? new Date('2026-01-15T09:00:00Z') : null },
      create: { email: `driver${index.toString().padStart(2, '0')}@sendit.local`, password, name: `Seed Driver ${index.toString().padStart(2, '0')}`, phone: `072${index.toString().padStart(7, '0')}`, role: UserRole.DRIVER, licenseNumber: `SEED-DL-${index.toString().padStart(3, '0')}`, vehicleNumber: `KSE ${index.toString().padStart(3, '0')}D`, vehicleType: index % 3 === 0 ? VehicleType.TRUCK : VehicleType.VAN, isActive: !deactivated, deletedAt: deactivated ? new Date('2026-01-15T09:00:00Z') : null },
    });
    drivers.push(driver.id);
  }

  const routeDefinitions = [
    ['Mombasa-Nairobi', 'Mombasa', 'Nairobi', ['Voi', 'Mtito Andei', 'Athi River']],
    ['Nairobi-Kisumu', 'Nairobi', 'Kisumu', ['Naivasha', 'Nakuru', 'Kericho', 'Ahero']],
    ['Nairobi-Eldoret', 'Nairobi', 'Eldoret', ['Naivasha', 'Nakuru', 'Molo']],
    ['Nakuru-Kakamega', 'Nakuru', 'Kakamega', ['Eldoret', 'Webuye', 'Bungoma', 'Mumias']],
    ['Nairobi-Nyeri', 'Nairobi', 'Nyeri', ['Thika', 'Sagana', 'Karatina']],
    ['Kisumu-Busia', 'Kisumu', 'Busia', ['Maseno', 'Luanda', 'Mumias', 'Bumala']],
    ['Meru-Embu', 'Meru', 'Embu', ['Chuka', 'Chogoria', 'Runyenjes']],
    ['Nairobi-Garissa', 'Nairobi', 'Garissa', ['Thika', 'Mwingi', 'Tseikuru', 'Bura', 'Madogo']],
  ] as const;
  const routeIds = [...base.routeIds];
  for (const [routeIndex, definition] of routeDefinitions.entries()) {
    const [name, origin, destination, stops] = definition;
    const route = await prisma.route.upsert({ where: { name }, update: { active: true }, create: { name, origin, destination } });
    routeIds.push(route.id);
    for (const [stopIndex, stopName] of stops.entries()) {
      const pointId = `seed-route-${routeIndex + 3}-point-${stopIndex + 1}`;
      const point = await prisma.transitPoint.upsert({ where: { id: pointId }, update: { active: true }, create: { id: pointId, name: `${stopName} Transit Point`, latitude: -1 + routeIndex * 0.15 + stopIndex * 0.02, longitude: 35 + routeIndex * 0.25 + stopIndex * 0.03, active: true } });
      await prisma.routeTransitPoint.upsert({ where: { routeId_transitPointId: { routeId: route.id, transitPointId: point.id } }, update: { sequence: stopIndex + 1 }, create: { routeId: route.id, transitPointId: point.id, sequence: stopIndex + 1 } });
    }
  }
  const kisiiStops = ['Keroka', 'Narok', 'Mai Mahiu'];
  for (const [index, name] of kisiiStops.entries()) {
    const id = `seed-kisii-nairobi-point-${index + 1}`;
    const point = await prisma.transitPoint.upsert({ where: { id }, update: {}, create: { id, name: `${name} Transit Point`, latitude: -0.7 - index * 0.2, longitude: 35.2 + index * 0.4 } });
    await prisma.routeTransitPoint.upsert({ where: { routeId_transitPointId: { routeId: routeIds[0], transitPointId: point.id } }, update: { sequence: index + 1 }, create: { routeId: routeIds[0], transitPointId: point.id, sequence: index + 1 } });
  }

  for (const [index, driverId] of drivers.entries()) {
    const served = [routeIds[index % routeIds.length], routeIds[(index + 3) % routeIds.length]];
    await prisma.driverProfile.upsert({ where: { userId: driverId }, update: { routesServed: served, currentRouteId: served[0], approvalStatus: index === 14 ? DriverStatus.DEACTIVATED : DriverStatus.APPROVED }, create: { userId: driverId, routesServed: served, currentRouteId: served[0], approvalStatus: index === 14 ? DriverStatus.DEACTIVATED : DriverStatus.APPROVED } });
  }

  const statuses = [ParcelStatus.pending, ParcelStatus.assigned, ParcelStatus.picked_up, ParcelStatus.in_transit, ParcelStatus.delivered_to_recipient, ParcelStatus.delivered, ParcelStatus.completed, ParcelStatus.cancelled];
  const statusesWithDrivers = new Set<ParcelStatus>([ParcelStatus.assigned, ParcelStatus.picked_up, ParcelStatus.in_transit, ParcelStatus.delivered_to_recipient, ParcelStatus.delivered, ParcelStatus.completed]);
  const station = await prisma.lockerStation.findUniqueOrThrow({ where: { name: 'Meru Central Lockers' } });
  const routeRecords = await prisma.route.findMany({ where: { id: { in: routeIds } } });
  const oldAssignments = await prisma.lockerAssignment.findMany({ where: { id: { startsWith: 'seed-locker-assignment-' } }, select: { id: true } });
  await prisma.collectionCode.updateMany({ where: { lockerAssignmentId: { in: oldAssignments.map(item => item.id) }, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.lockerAssignment.updateMany({ where: { id: { startsWith: 'seed-locker-assignment-' }, cancelledAt: null }, data: { cancelledAt: new Date() } });
  await prisma.lockerCompartment.updateMany({ where: { stationId: station.id, compartmentNo: { startsWith: 'S-' } }, data: { status: LockerStatus.AVAILABLE, currentParcelId: null } });
  for (let index = 1; index <= 200; index++) {
    const status = statuses[(index - 1) % statuses.length];
    const routeId = routeIds[(index - 1) % routeIds.length];
    const route = routeRecords.find(item => item.id === routeId)!;
    const sender = customers[(index - 1) % 5];
    const recipient = customers[5 + ((index - 1) % 3)];
    const driverId = statusesWithDrivers.has(status) ? drivers[(index - 1) % 14] : null;
    const trackingNumber = `SENDIT-SEED-${index.toString().padStart(4, '0')}`;
    const parcel = await prisma.parcel.upsert({
      where: { trackingNumber },
      update: { senderId: sender.id, senderName: sender.name, senderEmail: sender.email, senderPhone: sender.phone!, recipientId: recipient.id, recipientName: recipient.name, recipientEmail: recipient.email, recipientPhone: recipient.phone!, status, routeId, driverId, pickupAddress: route.origin, deliveryAddress: route.destination, currentLocation: route.origin, createdAt: new Date(Date.now() - (index % 56) * 86_400_000), deletedAt: null },
      create: { trackingNumber, senderId: sender.id, senderName: sender.name, senderEmail: sender.email, senderPhone: sender.phone!, recipientId: recipient.id, recipientName: recipient.name, recipientEmail: recipient.email, recipientPhone: recipient.phone!, driverId, routeId, pickupAddress: route.origin, deliveryAddress: route.destination, currentLocation: route.origin, status, weight: 0.5 + (index % 12), quantity: 1 + (index % 3), category: index % 4 === 0 ? 'Fragile' : 'General', isFragile: index % 4 === 0, description: `Seeded ${status} use case`, createdAt: new Date(Date.now() - (index % 56) * 86_400_000) },
    });
    if (!(await prisma.parcelStatusHistory.findFirst({ where: { parcelId: parcel.id, notes: 'Bulk seed operational state' } }))) await prisma.parcelStatusHistory.create({ data: { parcelId: parcel.id, status, updatedBy: base.adminId, location: parcel.currentLocation, notes: 'Bulk seed operational state' } });
  }
  for (const customer of customers) {
    const [sent, received] = await Promise.all([prisma.parcel.count({ where: { senderId: customer.id } }), prisma.parcel.count({ where: { recipientId: customer.id } })]);
    await prisma.user.update({ where: { id: customer.id }, data: { totalParcelsEverSent: sent, totalParcelsReceived: received } });
  }
  const historyStart = new Date(Date.now() - 28 * 86_400_000);
  const history = await prisma.parcel.findMany({ where: { trackingNumber: { startsWith: 'SENDIT-SEED-' }, createdAt: { gte: historyStart } }, select: { deliveryAddress: true, createdAt: true } });
  const demand = new Map<string, number[]>();
  for (const item of history) { const weeksAgo = Math.min(3, Math.floor((Date.now() - item.createdAt.getTime()) / (7 * 86_400_000))); const counts = demand.get(item.deliveryAddress) ?? [0, 0, 0, 0]; counts[3 - weeksAgo]++; demand.set(item.deliveryAddress, counts); }
  await prisma.demandForecast.deleteMany({ where: { model: 'seed-four-week-recency-weighted-v2' } });
  for (const [destination, counts] of demand) await prisma.demandForecast.create({ data: { destination, periodStart: new Date(), periodEnd: new Date(Date.now() + 7 * 86_400_000), ...forecastWeeklyVolume(counts), model: 'seed-four-week-recency-weighted-v2' } });
  const allPoints = await prisma.transitPoint.findMany({ where: { active: true }, orderBy: { id: 'asc' } });
  for (const [index, point] of allPoints.entries()) {
    const officer = await prisma.user.upsert({
      where: { email: `transit.officer${(index + 1).toString().padStart(2, '0')}@sendit.local` },
      update: { password, role: UserRole.TRANSIT_OFFICER, isActive: true, deletedAt: null },
      create: { email: `transit.officer${(index + 1).toString().padStart(2, '0')}@sendit.local`, password, name: `${point.name} Officer`, phone: `073${(index + 1).toString().padStart(7, '0')}`, role: UserRole.TRANSIT_OFFICER },
    });
    await prisma.transitPointOfficer.upsert({ where: { officerId: officer.id }, update: { transitPointId: point.id, nominatedBy: base.adminId }, create: { transitPointId: point.id, officerId: officer.id, nominatedBy: base.adminId } });
    await prisma.transitPoint.update({ where: { id: point.id }, data: { officerId: point.officerId ?? officer.id } });
  }
  return { customers: customers.length, drivers: drivers.length, routes: routeIds.length, parcels: 200, forecasts: demand.size };
}

async function main() {
  const password = await bcrypt.hash(demoPassword, 12);
  const upsertUser = (email: string, name: string, role: UserRole, extra = {}) => prisma.user.upsert({ where: { email }, update: { password, name, role, isActive: true, ...extra }, create: { email, password, name, role, isActive: true, ...extra } });
  const admin = await upsertUser('sendit@gmail.com', 'SendIT Administrator', UserRole.ADMIN);
  const customer = await upsertUser('demo.customer@sendit.local', 'Demo Customer', UserRole.CUSTOMER, { phone: '0700000001' });
  const officer = await upsertUser('meru.officer@sendit.local', 'Meru Transit Officer', UserRole.TRANSIT_OFFICER, { phone: '0700000002' });
  const driverOne = await upsertUser('kisii.driver@sendit.local', 'Kisii Route Driver', UserRole.DRIVER, { phone: '0700000003', licenseNumber: 'DEMO-DL-001', vehicleNumber: 'KDA 101A', vehicleType: VehicleType.VAN });
  const driverTwo = await upsertUser('meru.driver@sendit.local', 'Meru Route Driver', UserRole.DRIVER, { phone: '0700000004', licenseNumber: 'DEMO-DL-002', vehicleNumber: 'KDB 202B', vehicleType: VehicleType.VAN });
  const firstRoute = await prisma.route.upsert({ where: { name: 'Kisii-Nairobi' }, update: {}, create: { name: 'Kisii-Nairobi', origin: 'Kisii', destination: 'Nairobi' } });
  const onwardRoute = await prisma.route.upsert({ where: { name: 'Nairobi-Meru' }, update: {}, create: { name: 'Nairobi-Meru', origin: 'Nairobi', destination: 'Meru' } });
  await prisma.driverProfile.upsert({ where: { userId: driverOne.id }, update: { routesServed: [firstRoute.id], approvalStatus: DriverStatus.APPROVED }, create: { userId: driverOne.id, routesServed: [firstRoute.id], currentRouteId: firstRoute.id, approvalStatus: DriverStatus.APPROVED } });
  await prisma.driverProfile.upsert({ where: { userId: driverTwo.id }, update: { routesServed: [onwardRoute.id], approvalStatus: DriverStatus.APPROVED }, create: { userId: driverTwo.id, routesServed: [onwardRoute.id], currentRouteId: onwardRoute.id, approvalStatus: DriverStatus.APPROVED } });
  const thika = await prisma.transitPoint.upsert({ where: { id: 'demo-thika-point' }, update: {}, create: { id: 'demo-thika-point', name: 'Thika Transit Hub', latitude: -1.0332, longitude: 37.0693 } });
  const chuka = await prisma.transitPoint.upsert({ where: { id: 'demo-chuka-point' }, update: {}, create: { id: 'demo-chuka-point', name: 'Chuka Transit Hub', latitude: -0.3332, longitude: 37.6459 } });
  const meru = await prisma.transitPoint.upsert({ where: { id: 'demo-meru-point' }, update: { officerId: officer.id }, create: { id: 'demo-meru-point', name: 'Meru Destination Hub', latitude: 0.0463, longitude: 37.6559, officerId: officer.id } });
  for (const [point, sequence] of [[thika, 1], [chuka, 2], [meru, 3]] as const) await prisma.routeTransitPoint.upsert({ where: { routeId_transitPointId: { routeId: onwardRoute.id, transitPointId: point.id } }, update: { sequence }, create: { routeId: onwardRoute.id, transitPointId: point.id, sequence } });
  const station = await prisma.lockerStation.upsert({ where: { name: 'Meru Central Lockers' }, update: { transitPointId: meru.id }, create: { name: 'Meru Central Lockers', address: 'Meru CBD', transitPointId: meru.id, latitude: 0.0463, longitude: 37.6559 } });
  const compartment = await prisma.lockerCompartment.upsert({ where: { stationId_compartmentNo: { stationId: station.id, compartmentNo: 'M-01' } }, update: { status: LockerStatus.AWAITING_COLLECTION }, create: { stationId: station.id, compartmentNo: 'M-01', size: 'MEDIUM', status: LockerStatus.AWAITING_COLLECTION } });
  const parcel = await prisma.parcel.upsert({ where: { trackingNumber: 'SENDIT-DEMO-REROUTE-001' }, update: { routeId: onwardRoute.id, driverId: driverTwo.id, currentTransitPointId: meru.id, currentLocation: 'Meru Central Lockers, M-01', status: ParcelStatus.in_locker }, create: { trackingNumber: 'SENDIT-DEMO-REROUTE-001', senderId: customer.id, senderName: customer.name, senderEmail: customer.email, senderPhone: customer.phone!, recipientId: customer.id, recipientName: customer.name, recipientEmail: customer.email, recipientPhone: customer.phone!, driverId: driverTwo.id, pickupAddress: 'Kisii', deliveryAddress: 'Meru', currentLocation: 'Meru Central Lockers, M-01', routeId: onwardRoute.id, currentTransitPointId: meru.id, status: ParcelStatus.in_locker, weight: 2.5, description: 'Rerouted in Nairobi, passed Thika and Chuka, then assigned to a Meru locker' } });
  await prisma.lockerCompartment.update({ where: { id: compartment.id }, data: { currentParcelId: parcel.id } });
  const assignment = await prisma.lockerAssignment.upsert({ where: { id: 'demo-locker-assignment' }, update: { parcelId: parcel.id, compartmentId: compartment.id, cancelledAt: null, collectedAt: null }, create: { id: 'demo-locker-assignment', parcelId: parcel.id, compartmentId: compartment.id, assignedBy: officer.id } });
  const codeHash = await bcrypt.hash(demoLockerCode, 10);
  await prisma.collectionCode.upsert({ where: { id: 'demo-collection-code' }, update: { codeHash, usedAt: null, expiresAt: new Date(Date.now() + 7 * 86_400_000) }, create: { id: 'demo-collection-code', lockerAssignmentId: assignment.id, codeHash, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
  const firstBatch = await prisma.batch.upsert({ where: { batchNumber: 'DEMO-KISII-NBO-001' }, update: {}, create: { batchNumber: 'DEMO-KISII-NBO-001', routeId: firstRoute.id, driverId: driverOne.id, status: BatchStatus.CLOSED, closedAt: new Date() } });
  const onwardBatch = await prisma.batch.upsert({ where: { batchNumber: 'DEMO-NBO-MERU-001' }, update: {}, create: { batchNumber: 'DEMO-NBO-MERU-001', routeId: onwardRoute.id, driverId: driverTwo.id, parentBatchId: firstBatch.id, status: BatchStatus.CLOSED, closedAt: new Date() } });
  await prisma.batchParcel.upsert({ where: { batchId_parcelId: { batchId: onwardBatch.id, parcelId: parcel.id } }, update: {}, create: { batchId: onwardBatch.id, parcelId: parcel.id, loadedAt: new Date(), loadedBy: driverTwo.id } });
  if (!(await prisma.parcelStatusHistory.findFirst({ where: { parcelId: parcel.id, notes: { startsWith: 'Demo reroute' } } }))) for (const [status, location, notes] of [[ParcelStatus.at_transit_point, 'Nairobi transfer hub', 'Demo reroute: verified and diverted to Nairobi-Meru'], [ParcelStatus.in_transit, 'Thika Transit Hub', 'Onward route passed Thika'], [ParcelStatus.arrived_at_transit_point, 'Chuka Transit Hub', 'Verified intact at Chuka'], [ParcelStatus.at_destination, 'Meru Destination Hub', 'Verified at destination; locker requested'], [ParcelStatus.in_locker, 'Meru Central Lockers, M-01', 'Placed in assigned locker M-01']] as const) await prisma.parcelStatusHistory.create({ data: { parcelId: parcel.id, status, location, notes, updatedBy: officer.id } });
  const volume = await seedOperationalVolume(password, { adminId: admin.id, customerId: customer.id, officerId: officer.id, driverIds: [driverOne.id, driverTwo.id], routeIds: [firstRoute.id, onwardRoute.id] });
  console.log(`Seed complete | admin ${admin.email}/${demoPassword} | parcel ${parcel.trackingNumber} | locker code ${demoLockerCode} | ${volume.customers} customers | ${volume.drivers} drivers | ${volume.routes} routes | ${volume.parcels} bulk parcels | ${volume.forecasts} forecasts`);
}

main().finally(() => prisma.$disconnect());
