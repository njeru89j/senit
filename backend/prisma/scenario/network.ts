/**
 * The scenario delivery network, shared by the database seed and the end-to-end journey tests.
 *
 * Four routes meet at two interchanges (Nairobi and Thika). Routes are stored once and travelled in
 * both directions. Every scenario record is recognisable (ids start with "scn-", emails end with
 * SCENARIO_EMAIL_DOMAIN) so the scenario can be reset and replayed without touching other data.
 */
import * as bcrypt from 'bcrypt';
import { DriverStatus, LockerSize, PrismaClient, UserRole, VehicleType } from '@prisma/client';

export const SCENARIO_EMAIL_DOMAIN = 'scenario.sendit.local';
export const SCENARIO_PASSWORD = 'Scenario123';

export const STATIONS = {
  meru: { name: 'Meru', latitude: 0.0463, longitude: 37.6559 },
  chuka: { name: 'Chuka', latitude: -0.3332, longitude: 37.6459 },
  thika: { name: 'Thika', latitude: -1.0332, longitude: 37.0693 },
  juja: { name: 'Juja', latitude: -1.1022, longitude: 37.0144 },
  nairobi: { name: 'Nairobi', latitude: -1.2864, longitude: 36.8172 },
  ruaka: { name: 'Ruaka', latitude: -1.2072, longitude: 36.7785 },
  kiambu: { name: 'Kiambu', latitude: -1.1714, longitude: 36.8356 },
  limuru: { name: 'Limuru', latitude: -1.1136, longitude: 36.6423 },
  naivasha: { name: 'Naivasha', latitude: -0.7167, longitude: 36.4333 },
  nakuru: { name: 'Nakuru', latitude: -0.3031, longitude: 36.08 },
  sagana: { name: 'Sagana', latitude: -0.6667, longitude: 37.2 },
  karatina: { name: 'Karatina', latitude: -0.4833, longitude: 37.1333 },
  nyeri: { name: 'Nyeri', latitude: -0.4167, longitude: 36.95 },
} as const;
export type StationKey = keyof typeof STATIONS;

/** Ordered stops (endpoints included) with road distances in km from the previous stop. */
export const ROUTES = {
  meruNairobi: { name: 'Meru ↔ Nairobi', stops: [['meru', 0], ['chuka', 64], ['thika', 115], ['juja', 12], ['nairobi', 30]] },
  nairobiKiambu: { name: 'Nairobi ↔ Kiambu', stops: [['nairobi', 0], ['ruaka', 13], ['kiambu', 8]] },
  nairobiNakuru: { name: 'Nairobi ↔ Nakuru', stops: [['nairobi', 0], ['limuru', 35], ['naivasha', 55], ['nakuru', 70]] },
  thikaNyeri: { name: 'Thika ↔ Nyeri', stops: [['thika', 0], ['sagana', 55], ['karatina', 25], ['nyeri', 25]] },
} as const satisfies Record<string, { name: string; stops: ReadonlyArray<readonly [StationKey, number]> }>;
export type RouteKey = keyof typeof ROUTES;

export const DRIVERS = {
  peter: { name: 'Peter Kamau', phone: '0722000001', vehicleType: VehicleType.TRUCK, vehicleNumber: 'KDA 101T', maxLoadKg: 1500, routes: ['meruNairobi'] },
  grace: { name: 'Grace Wanjiru', phone: '0722000002', vehicleType: VehicleType.VAN, vehicleNumber: 'KDB 202V', maxLoadKg: 1000, routes: ['nairobiKiambu'] },
  john: { name: 'John Otieno', phone: '0722000003', vehicleType: VehicleType.VAN, vehicleNumber: 'KDC 303V', maxLoadKg: 800, routes: ['meruNairobi'] },
  mary: { name: 'Mary Achieng', phone: '0722000004', vehicleType: VehicleType.CAR, vehicleNumber: 'KDD 404C', maxLoadKg: 300, routes: ['meruNairobi', 'thikaNyeri'] },
  samuel: { name: 'Samuel Kiprop', phone: '0722000005', vehicleType: VehicleType.TRUCK, vehicleNumber: 'KDE 505T', maxLoadKg: 1500, routes: ['nairobiNakuru'] },
  joseph: { name: 'Joseph Mwangi', phone: '0722000006', vehicleType: VehicleType.MOTORCYCLE, vehicleNumber: 'KMF 606M', maxLoadKg: 15, routes: ['nairobiKiambu'] },
} as const satisfies Record<string, { name: string; phone: string; vehicleType: VehicleType; vehicleNumber: string; maxLoadKg: number; routes: readonly RouteKey[] }>;
export type DriverKey = keyof typeof DRIVERS;

export const CUSTOMERS = {
  alice: { name: 'Alice Njeri', phone: '0733000001' },
  brian: { name: 'Brian Mutua', phone: '0733000002' },
  carol: { name: 'Carol Wambui', phone: '0733000003' },
} as const;
export type CustomerKey = keyof typeof CUSTOMERS;

/** Guest recipient without an account: collects with ID at the counter. */
export const GUEST = { name: 'Dan Guest', email: 'dan.guest@example.com', phone: '0744000001' };

/** Locker banks. Juja deliberately has a single small compartment, so larger parcels fall back to the counter. */
export const LOCKERS: Partial<Record<StationKey, Array<[string, LockerSize]>>> = {
  kiambu: [['K-01', LockerSize.SMALL], ['K-02', LockerSize.MEDIUM], ['K-03', LockerSize.LARGE]],
  juja: [['J-01', LockerSize.SMALL]],
  nairobi: [['N-01', LockerSize.MEDIUM], ['N-02', LockerSize.LARGE]],
};

export const stationId = (key: StationKey) => `scn-tp-${key}`;
export const routeId = (key: RouteKey) => `scn-route-${key}`;
export const email = (local: string) => `${local}@${SCENARIO_EMAIL_DOMAIN}`;

export type ScenarioNetwork = {
  stations: Record<StationKey, string>;
  routes: Record<RouteKey, string>;
  officers: Record<StationKey, { id: string; email: string }>;
  drivers: Record<DriverKey, { id: string; email: string }>;
  customers: Record<CustomerKey, { id: string; email: string }>;
};

/** Removes every scenario record (and everything that references it) so the scenario can be replayed. */
export async function resetScenario(prisma: PrismaClient): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${SCENARIO_EMAIL_DOMAIN}` } }, select: { id: true } });
  const userIds = users.map((user) => user.id);
  const pointIds = (await prisma.transitPoint.findMany({ where: { id: { startsWith: 'scn-' } }, select: { id: true } })).map((point) => point.id);
  const parcels = await prisma.parcel.findMany({
    where: { OR: [{ senderId: { in: userIds } }, { recipientId: { in: userIds } }, { originTransitPointId: { in: pointIds } }, { destinationTransitPointId: { in: pointIds } }, { currentTransitPointId: { in: pointIds } }] },
    select: { id: true },
  });
  const parcelIds = parcels.map((parcel) => parcel.id);
  const lockerAssignmentIds = (await prisma.lockerAssignment.findMany({ where: { parcelId: { in: parcelIds } }, select: { id: true } })).map((item) => item.id);
  const tripIds = (await prisma.trip.findMany({ where: { OR: [{ driverId: { in: userIds } }, { routeId: { startsWith: 'scn-' } }] }, select: { id: true } })).map((trip) => trip.id);
  const stationIds = (await prisma.lockerStation.findMany({ where: { id: { startsWith: 'scn-' } }, select: { id: true } })).map((item) => item.id);

  await prisma.$transaction([
    prisma.notification.deleteMany({ where: { OR: [{ parcelId: { in: parcelIds } }, { userId: { in: userIds } }] } }),
    prisma.review.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.deliveryProof.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.parcelStatusHistory.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.transitInspection.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.tamperAlert.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.sealScan.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.parcelSeal.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.collectionCode.deleteMany({ where: { lockerAssignmentId: { in: lockerAssignmentIds } } }),
    prisma.lockerExtensionRequest.deleteMany({ where: { lockerAssignmentId: { in: lockerAssignmentIds } } }),
    prisma.lockerAssignment.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.lockerRequest.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.parcelAssignment.deleteMany({ where: { OR: [{ parcelId: { in: parcelIds } }, { driverId: { in: userIds } }, { tripId: { in: tripIds } }] } }),
    prisma.parcelLeg.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.batchParcel.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.parcel.deleteMany({ where: { id: { in: parcelIds } } }),
    prisma.tripEvent.deleteMany({ where: { tripId: { in: tripIds } } }),
    prisma.trip.deleteMany({ where: { id: { in: tripIds } } }),
    prisma.lockerCompartment.deleteMany({ where: { stationId: { in: stationIds } } }),
    prisma.lockerStation.deleteMany({ where: { id: { in: stationIds } } }),
    prisma.transitPointOfficer.deleteMany({ where: { OR: [{ transitPointId: { in: pointIds } }, { officerId: { in: userIds } }] } }),
    prisma.routeTransitPoint.deleteMany({ where: { OR: [{ routeId: { startsWith: 'scn-' } }, { transitPointId: { in: pointIds } }] } }),
    prisma.route.deleteMany({ where: { id: { startsWith: 'scn-' } } }),
    prisma.transitPoint.deleteMany({ where: { id: { in: pointIds } } }),
    prisma.driverProfile.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } }),
    prisma.user.deleteMany({ where: { id: { in: userIds } } }),
  ]);
}

/** Creates the scenario network: stations, bidirectional routes with distances, officers, drivers, customers and lockers. */
export async function buildScenarioNetwork(prisma: PrismaClient): Promise<ScenarioNetwork> {
  const password = await bcrypt.hash(SCENARIO_PASSWORD, 10);
  const stations = {} as Record<StationKey, string>;
  for (const [key, station] of Object.entries(STATIONS) as [StationKey, (typeof STATIONS)[StationKey]][]) {
    const point = await prisma.transitPoint.create({ data: { id: stationId(key), name: station.name, latitude: station.latitude, longitude: station.longitude, contact: `+254 700 ${String(Object.keys(stations).length + 1).padStart(3, '0')} 000` } });
    stations[key] = point.id;
  }

  const routes = {} as Record<RouteKey, string>;
  for (const [key, route] of Object.entries(ROUTES) as [RouteKey, (typeof ROUTES)[RouteKey]][]) {
    const first = STATIONS[route.stops[0][0]].name;
    const last = STATIONS[route.stops[route.stops.length - 1][0]].name;
    await prisma.route.create({ data: { id: routeId(key), name: route.name, origin: first, destination: last, active: true } });
    await prisma.routeTransitPoint.createMany({
      data: route.stops.map(([stop, km], index) => ({ routeId: routeId(key), transitPointId: stations[stop], sequence: index + 1, distanceFromPreviousKm: index ? km : null })),
    });
    routes[key] = routeId(key);
  }

  const officers = {} as ScenarioNetwork['officers'];
  for (const key of Object.keys(STATIONS) as StationKey[]) {
    const officer = await prisma.user.create({
      data: { email: email(`officer.${key}`), password, name: `${STATIONS[key].name} Station Officer`, phone: `07550000${String(Object.keys(officers).length + 10).padStart(2, '0')}`, role: UserRole.TRANSIT_OFFICER },
    });
    await prisma.transitPointOfficer.create({ data: { transitPointId: stations[key], officerId: officer.id } });
    await prisma.transitPoint.update({ where: { id: stations[key] }, data: { officerId: officer.id } });
    officers[key] = { id: officer.id, email: officer.email };
  }

  const drivers = {} as ScenarioNetwork['drivers'];
  for (const [key, driver] of Object.entries(DRIVERS) as [DriverKey, (typeof DRIVERS)[DriverKey]][]) {
    const user = await prisma.user.create({
      data: {
        email: email(`driver.${key}`), password, name: driver.name, phone: driver.phone, role: UserRole.DRIVER,
        licenseNumber: `SCN-DL-${key.toUpperCase()}`, vehicleNumber: driver.vehicleNumber, vehicleType: driver.vehicleType, maxLoadKg: driver.maxLoadKg,
        isAvailable: true, driverApplicationStatus: 'APPROVED', driverApprovalDate: new Date(),
        driverProfile: { create: { routesServed: driver.routes.map((route) => routes[route]), approvalStatus: DriverStatus.APPROVED } },
      },
    });
    drivers[key] = { id: user.id, email: user.email };
  }

  const customers = {} as ScenarioNetwork['customers'];
  for (const [key, customer] of Object.entries(CUSTOMERS) as [CustomerKey, (typeof CUSTOMERS)[CustomerKey]][]) {
    const user = await prisma.user.create({ data: { email: email(key), password, name: customer.name, phone: customer.phone, role: UserRole.CUSTOMER } });
    customers[key] = { id: user.id, email: user.email };
  }

  for (const [key, compartments] of Object.entries(LOCKERS) as [StationKey, Array<[string, LockerSize]>][]) {
    const station = await prisma.lockerStation.create({
      data: { id: `scn-lockers-${key}`, name: `${STATIONS[key].name} Smart Lockers (scenario)`, address: `${STATIONS[key].name} transit station`, transitPointId: stations[key], latitude: STATIONS[key].latitude, longitude: STATIONS[key].longitude, openingHours: '06:00-22:00' },
    });
    await prisma.lockerCompartment.createMany({ data: compartments.map(([compartmentNo, size]) => ({ stationId: station.id, compartmentNo, size })) });
  }

  return { stations, routes, officers, drivers, customers };
}
