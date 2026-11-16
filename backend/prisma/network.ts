/**
 * The operational delivery network used by the main database seed.
 *
 * Nairobi is the core of the network, but it is not the only way through it: of the fifteen routes,
 * eight run through Nairobi and seven connect regions directly (for example Nakuru ↔ Kisumu and
 * Mombasa ↔ Malindi), so parcels transfer at Nakuru, Kisumu, Eldoret, Nyeri, Meru, Thika and Mombasa
 * as well. Routes are stored once and travelled in both directions.
 *
 * Every record created here is recognisable — ids start with "net-" and staff emails end with
 * NETWORK_EMAIL_DOMAIN — so the seed can be re-run without touching customers or other data.
 */
import * as bcrypt from 'bcrypt';
import { DriverStatus, LockerSize, PrismaClient, UserRole, VehicleType } from '@prisma/client';

export const NETWORK_EMAIL_DOMAIN = 'sendit.com';
export const NETWORK_PASSWORD = 'Admin123';

/** 40 compartments at every station. */
export const LOCKERS_PER_STATION: ReadonlyArray<readonly [LockerSize, number, string]> = [
  [LockerSize.SMALL, 16, 'S'],
  [LockerSize.MEDIUM, 12, 'M'],
  [LockerSize.LARGE, 8, 'L'],
  [LockerSize.EXTRA_LARGE, 4, 'X'],
];

/**
 * A hub network: Nairobi is the centre and every route is a spoke out of it. No station appears on
 * two routes, so routes never overlap; a parcel between two spokes transfers once, at Nairobi.
 * Each station carries the street address its counter operates from.
 */
export const STATIONS = {
  nairobi: { name: 'Nairobi', code: 'NBO', latitude: -1.2864, longitude: 36.8172, address: 'Kenmosa Plaza, Tom Mboya Street, opposite Afya Centre, 3rd floor, Room 12A' },
  ruiru: { name: 'Ruiru', code: 'RUI', latitude: -1.15, longitude: 36.96, address: 'Bypass Business Centre, Kenyatta Road, next to Naivas Supermarket, 1st floor, Room 6C' },
  juja: { name: 'Juja', code: 'JUJ', latitude: -1.1022, longitude: 37.0144, address: 'Highpoint Plaza, Juja Town, opposite the JKUAT main gate, 2nd floor, Room 21B' },
  thika: { name: 'Thika', code: 'THK', latitude: -1.0332, longitude: 37.0693, address: 'Mwalimu House, Kenyatta Highway, opposite Quickmart Supermarket, 2nd floor, Room 34B' },
  sagana: { name: 'Sagana', code: 'SGN', latitude: -0.6667, longitude: 37.2, address: 'Riverside Arcade, Sagana Junction, next to the Shell petrol station, ground floor, Shop 4' },
  karatina: { name: 'Karatina', code: 'KTN', latitude: -0.4833, longitude: 37.1333, address: 'Market View House, Karatina Town, behind the open-air market, 1st floor, Room 9' },
  nyeri: { name: 'Nyeri', code: 'NYR', latitude: -0.4167, longitude: 36.95, address: 'Kimathi Plaza, Kimathi Way, opposite Nyeri Post Office, 3rd floor, Room 30A' },
  embu: { name: 'Embu', code: 'EMB', latitude: -0.5389, longitude: 37.4575, address: 'Ena Business Park, Kenyatta Highway, next to Equity Bank, 2nd floor, Room 17' },
  chuka: { name: 'Chuka', code: 'CHK', latitude: -0.3332, longitude: 37.6459, address: 'Tharaka House, Chuka Town, opposite the Chuka University gate, 1st floor, Room 5B' },
  meru: { name: 'Meru', code: 'MRU', latitude: 0.0463, longitude: 37.6559, address: 'Njuri Ncheke Plaza, Ghana Street, above Cooperative Bank, 4th floor, Room 44' },
  nanyuki: { name: 'Nanyuki', code: 'NNK', latitude: -0.0167, longitude: 37.0667, address: 'Equator Court, Nanyuki Town, opposite the county offices, 2nd floor, Room 14C' },
  timau: { name: 'Timau', code: 'TMU', latitude: 0.0833, longitude: 37.25, address: 'Timau Trade Centre, Meru-Nanyuki Highway, next to the police post, ground floor, Shop 2' },
  isiolo: { name: 'Isiolo', code: 'ISL', latitude: 0.3546, longitude: 37.5822, address: 'Waso Plaza, Isiolo Town, opposite the main bus stage, 1st floor, Room 11' },
  ruaka: { name: 'Ruaka', code: 'RKA', latitude: -1.2072, longitude: 36.7785, address: 'Ruaka Square, Limuru Road, next to Two Rivers Mall, 2nd floor, Room 8D' },
  kiambu: { name: 'Kiambu', code: 'KBU', latitude: -1.1714, longitude: 36.8356, address: 'Biashara House, Biashara Street, opposite Kiambu Level 5 Hospital, 3rd floor, Room 27' },
  githunguri: { name: 'Githunguri', code: 'GTG', latitude: -1.05, longitude: 36.8167, address: 'Dairy Plaza, Githunguri Town, next to the KCC depot, 1st floor, Room 3A' },
  limuru: { name: 'Limuru', code: 'LMR', latitude: -1.1136, longitude: 36.6423, address: 'Tigoni House, Limuru Town, opposite the railway station, 2nd floor, Room 19' },
  naivasha: { name: 'Naivasha', code: 'NVS', latitude: -0.7167, longitude: 36.4333, address: 'Lakeview Centre, Moi Avenue, next to Naivas Supermarket, 1st floor, Room 7B' },
  gilgil: { name: 'Gilgil', code: 'GLG', latitude: -0.5, longitude: 36.3167, address: 'Kariandusi Arcade, Gilgil Town, opposite the barracks gate, ground floor, Shop 10' },
  nakuru: { name: 'Nakuru', code: 'NKR', latitude: -0.3031, longitude: 36.08, address: 'Westside Towers, Kenyatta Avenue, above Java House, 5th floor, Room 52' },
  eldoret: { name: 'Eldoret', code: 'ELD', latitude: 0.5143, longitude: 35.2698, address: 'Zion Mall Annex, Uganda Road, opposite Rupa Mall, 3rd floor, Room 33' },
  kitale: { name: 'Kitale', code: 'KTL', latitude: 1.0157, longitude: 35.0062, address: 'Mt Elgon Plaza, Kenyatta Street, next to Kitale Museum, 2nd floor, Room 16' },
  kisumu: { name: 'Kisumu', code: 'KSM', latitude: -0.0917, longitude: 34.768, address: 'Tuff Foam Mall, Oginga Odinga Street, opposite Mega Plaza, 4th floor, Room 40B' },
  kakamega: { name: 'Kakamega', code: 'KKG', latitude: 0.2827, longitude: 34.7519, address: 'Ambwere Complex, Kakamega Town, next to Equity Bank, 2nd floor, Room 22' },
  bungoma: { name: 'Bungoma', code: 'BGM', latitude: 0.5635, longitude: 34.5606, address: 'Khetias Plaza, Moi Avenue, opposite the county headquarters, 1st floor, Room 12' },
  kisii: { name: 'Kisii', code: 'KSI', latitude: -0.6817, longitude: 34.7667, address: 'Mwalimu Centre, Hospital Road, opposite Kisii Teaching Hospital, 3rd floor, Room 29C' },
  migori: { name: 'Migori', code: 'MGR', latitude: -1.0634, longitude: 34.4731, address: 'Suna Plaza, Migori Town, next to the Total petrol station, 1st floor, Room 6' },
  narok: { name: 'Narok', code: 'NRK', latitude: -1.0833, longitude: 35.8667, address: 'Maasai Mara House, Narok Town, opposite the county offices, 2nd floor, Room 18A' },
  bomet: { name: 'Bomet', code: 'BMT', latitude: -0.7833, longitude: 35.3417, address: 'Highland Plaza, Bomet Town, next to the main bus park, 1st floor, Room 4' },
  kericho: { name: 'Kericho', code: 'KRC', latitude: -0.3689, longitude: 35.2861, address: 'Tea Hotel Arcade, Moi Highway, opposite Green Stadium, 2nd floor, Room 25' },
  kajiado: { name: 'Kajiado', code: 'KJD', latitude: -1.85, longitude: 36.7833, address: 'Olkejuado House, Kajiado Town, opposite the law courts, 3rd floor, Room 31' },
  namanga: { name: 'Namanga', code: 'NMG', latitude: -2.55, longitude: 36.7833, address: 'Border Trade Centre, Namanga, next to the immigration offices, ground floor, Shop 7' },
  athiriver: { name: 'Athi River', code: 'ATR', latitude: -1.45, longitude: 36.9833, address: 'EPZ Business Park, Mombasa Road, opposite Signature Mall, 2nd floor, Room 20' },
  machakos: { name: 'Machakos', code: 'MCK', latitude: -1.5167, longitude: 37.2667, address: 'Mumbuni House, Syokimau Street, next to Machakos Peoples Park, 3rd floor, Room 36' },
  makueni: { name: 'Makueni', code: 'MKN', latitude: -1.8038, longitude: 37.6237, address: 'Wote Plaza, Makueni Town, opposite the county assembly, 1st floor, Room 9B' },
  mwingi: { name: 'Mwingi', code: 'MWG', latitude: -0.9333, longitude: 38.0667, address: 'Kyuso Arcade, Mwingi Town, next to the main bus stage, ground floor, Shop 5' },
  kitui: { name: 'Kitui', code: 'KTI', latitude: -1.3667, longitude: 38.0167, address: 'Kalundu Centre, Kitui Town, opposite Kitui Level 5 Hospital, 2nd floor, Room 23' },
  garissa: { name: 'Garissa', code: 'GRS', latitude: -0.4536, longitude: 39.6461, address: 'Tana Plaza, Garissa Town, next to the county commissioner office, 1st floor, Room 15' },
  emali: { name: 'Emali', code: 'EML', latitude: -2.0833, longitude: 37.45, address: 'Junction Trade Centre, Mombasa Road, opposite the railway crossing, ground floor, Shop 3' },
  mtitoandei: { name: 'Mtito Andei', code: 'MTA', latitude: -2.6833, longitude: 38.1667, address: 'Tsavo Stopover Plaza, Mombasa Road, next to the Shell service station, 1st floor, Room 2' },
  voi: { name: 'Voi', code: 'VOI', latitude: -3.3961, longitude: 38.5561, address: 'Taita Towers, Voi Town, opposite the SGR station road, 2nd floor, Room 13' },
  mombasa: { name: 'Mombasa', code: 'MSA', latitude: -4.0435, longitude: 39.6682, address: 'Jubilee Insurance House, Moi Avenue, opposite the Tusks, 4th floor, Room 41A' },
  kilifi: { name: 'Kilifi', code: 'KLF', latitude: -3.6305, longitude: 39.8499, address: 'Creek Plaza, Kilifi Town, next to the Pwani University gate, 1st floor, Room 8' },
  malindi: { name: 'Malindi', code: 'MLD', latitude: -3.2175, longitude: 40.1191, address: 'Sabaki House, Lamu Road, opposite Malindi Complex, 2nd floor, Room 26' },
  lamu: { name: 'Lamu', code: 'LAM', latitude: -2.2717, longitude: 40.902, address: 'Mkomani Building, Lamu Waterfront, next to the jetty offices, 1st floor, Room 1B' },
} as const;
export type StationKey = keyof typeof STATIONS;

/**
 * Every route starts at Nairobi and runs outward, in both directions. Distances are road km from the
 * previous stop.
 */
export const ROUTES = {
  thikaRoad: { stops: [['nairobi', 0], ['ruiru', 25], ['juja', 10], ['thika', 15]] },
  mtKenyaWest: { stops: [['nairobi', 0], ['sagana', 105], ['karatina', 25], ['nyeri', 25]] },
  mtKenyaEast: { stops: [['nairobi', 0], ['embu', 120], ['chuka', 40], ['meru', 65]] },
  laikipia: { stops: [['nairobi', 0], ['nanyuki', 195], ['timau', 30], ['isiolo', 45]] },
  kiambuLocal: { stops: [['nairobi', 0], ['ruaka', 15], ['kiambu', 10], ['githunguri', 20]] },
  riftValley: { stops: [['nairobi', 0], ['limuru', 35], ['naivasha', 50], ['gilgil', 25], ['nakuru', 45]] },
  northRift: { stops: [['nairobi', 0], ['eldoret', 310], ['kitale', 70]] },
  western: { stops: [['nairobi', 0], ['kisumu', 350], ['kakamega', 50], ['bungoma', 65]] },
  southNyanza: { stops: [['nairobi', 0], ['kisii', 305], ['migori', 65]] },
  mara: { stops: [['nairobi', 0], ['narok', 145], ['bomet', 95], ['kericho', 55]] },
  southBorder: { stops: [['nairobi', 0], ['kajiado', 80], ['namanga', 85]] },
  ukambaniSouth: { stops: [['nairobi', 0], ['athiriver', 30], ['machakos', 35], ['makueni', 85]] },
  eastern: { stops: [['nairobi', 0], ['mwingi', 180], ['kitui', 65], ['garissa', 220]] },
  coast: { stops: [['nairobi', 0], ['emali', 110], ['mtitoandei', 95], ['voi', 100], ['mombasa', 155]] },
  coastNorth: { stops: [['nairobi', 0], ['kilifi', 510], ['malindi', 60], ['lamu', 220]] },
} as const satisfies Record<string, { stops: ReadonlyArray<readonly [StationKey, number]> }>;
export type RouteKey = keyof typeof ROUTES;

/** Ten drivers per route: two motorcycles for short hops, then cars, vans and trucks. */
export const FLEET: ReadonlyArray<readonly [VehicleType, number]> = [
  [VehicleType.MOTORCYCLE, 15],
  [VehicleType.MOTORCYCLE, 20],
  [VehicleType.CAR, 300],
  [VehicleType.CAR, 300],
  [VehicleType.CAR, 400],
  [VehicleType.VAN, 800],
  [VehicleType.VAN, 1000],
  [VehicleType.VAN, 1000],
  [VehicleType.TRUCK, 1500],
  [VehicleType.TRUCK, 2000],
];

const FIRST_NAMES = ['Peter', 'Grace', 'John', 'Mary', 'Samuel', 'Joseph', 'Alice', 'Brian', 'Carol', 'David', 'Esther', 'Felix', 'Hellen', 'Isaac', 'Janet'];
const LAST_NAMES = ['Kamau', 'Wanjiru', 'Otieno', 'Achieng', 'Kiprop', 'Mwangi', 'Njeri', 'Mutua', 'Chebet', 'Omondi'];

/** Ordered stops of a route as plain tuples, for iteration. */
export const routeStops = (key: RouteKey): ReadonlyArray<readonly [StationKey, number]> => ROUTES[key].stops;

export const stationId = (key: StationKey) => `net-tp-${key}`;
export const routeId = (key: RouteKey) => `net-route-${key}`;
export const lockerStationId = (key: StationKey) => `net-lockers-${key}`;
export const officerEmail = (key: StationKey) => `${key}@${NETWORK_EMAIL_DOMAIN}`;
export const driverEmail = (index: number) => `driver${index}@${NETWORK_EMAIL_DOMAIN}`;
export const routeName = (key: RouteKey) => {
  const stops = routeStops(key);
  return `${STATIONS[stops[0][0]].name} ↔ ${STATIONS[stops[stops.length - 1][0]].name}`;
};
export const routeLengthKm = (key: RouteKey) => routeStops(key).reduce((total, [, km]) => total + km, 0);

export type Network = {
  stations: Record<StationKey, string>;
  routes: Record<RouteKey, string>;
  officers: Array<{ station: StationKey; email: string }>;
  drivers: Array<{ email: string; route: RouteKey; vehicleType: VehicleType; maxLoadKg: number }>;
};

/** Removes the previously seeded network (and the work that references it) so the seed can be re-run. */
export async function resetNetwork(prisma: PrismaClient): Promise<void> {
  const staff = await prisma.user.findMany({ where: { email: { endsWith: `@${NETWORK_EMAIL_DOMAIN}` } }, select: { id: true } });
  const staffIds = staff.map((user) => user.id);
  const pointIds = (await prisma.transitPoint.findMany({ where: { id: { startsWith: 'net-' } }, select: { id: true } })).map((point) => point.id);
  const parcelIds = (await prisma.parcel.findMany({
    where: { OR: [{ originTransitPointId: { in: pointIds } }, { destinationTransitPointId: { in: pointIds } }, { currentTransitPointId: { in: pointIds } }, { driverId: { in: staffIds } }] },
    select: { id: true },
  })).map((parcel) => parcel.id);
  const lockerAssignmentIds = (await prisma.lockerAssignment.findMany({ where: { parcelId: { in: parcelIds } }, select: { id: true } })).map((item) => item.id);
  const tripIds = (await prisma.trip.findMany({ where: { OR: [{ driverId: { in: staffIds } }, { routeId: { startsWith: 'net-' } }] }, select: { id: true } })).map((trip) => trip.id);
  const lockerStationIds = (await prisma.lockerStation.findMany({ where: { id: { startsWith: 'net-' } }, select: { id: true } })).map((item) => item.id);

  await prisma.$transaction([
    prisma.notification.deleteMany({ where: { OR: [{ parcelId: { in: parcelIds } }, { userId: { in: staffIds } }] } }),
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
    prisma.parcelAssignment.deleteMany({ where: { OR: [{ parcelId: { in: parcelIds } }, { driverId: { in: staffIds } }, { tripId: { in: tripIds } }] } }),
    prisma.parcelLeg.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.batchParcel.deleteMany({ where: { parcelId: { in: parcelIds } } }),
    prisma.parcel.deleteMany({ where: { id: { in: parcelIds } } }),
    prisma.tripEvent.deleteMany({ where: { tripId: { in: tripIds } } }),
    prisma.trip.deleteMany({ where: { id: { in: tripIds } } }),
    prisma.lockerCompartment.deleteMany({ where: { stationId: { in: lockerStationIds } } }),
    prisma.lockerStation.deleteMany({ where: { id: { in: lockerStationIds } } }),
    prisma.transitPointOfficer.deleteMany({ where: { OR: [{ transitPointId: { in: pointIds } }, { officerId: { in: staffIds } }] } }),
    prisma.routeTransitPoint.deleteMany({ where: { OR: [{ routeId: { startsWith: 'net-' } }, { transitPointId: { in: pointIds } }] } }),
    prisma.route.deleteMany({ where: { id: { startsWith: 'net-' } } }),
    prisma.transitPoint.deleteMany({ where: { id: { in: pointIds } } }),
    prisma.driverProfile.deleteMany({ where: { userId: { in: staffIds } } }),
    prisma.refreshToken.deleteMany({ where: { userId: { in: staffIds } } }),
    prisma.auditLog.deleteMany({ where: { userId: { in: staffIds } } }),
    prisma.user.deleteMany({ where: { id: { in: staffIds } } }),
  ]);
}

/** Creates stations, two-way routes, one officer per station, 40 lockers per station and ten drivers per route. */
export async function buildNetwork(prisma: PrismaClient, log: (line: string) => void = () => {}): Promise<Network> {
  const password = await bcrypt.hash(NETWORK_PASSWORD, 10);
  const stationKeys = Object.keys(STATIONS) as StationKey[];
  const routeKeys = Object.keys(ROUTES) as RouteKey[];

  const stations = {} as Record<StationKey, string>;
  await prisma.transitPoint.createMany({
    data: stationKeys.map((key, index) => ({
      id: stationId(key), name: STATIONS[key].name, latitude: STATIONS[key].latitude, longitude: STATIONS[key].longitude,
      contact: `${STATIONS[key].address} · +254 700 ${String(index + 1).padStart(3, '0')} 100`, active: true,
    })),
  });
  for (const key of stationKeys) stations[key] = stationId(key);
  log(`${stationKeys.length} stations`);

  const routes = {} as Record<RouteKey, string>;
  for (const key of routeKeys) {
    const stops = routeStops(key);
    await prisma.route.create({
      data: { id: routeId(key), name: routeName(key), origin: STATIONS[stops[0][0]].name, destination: STATIONS[stops[stops.length - 1][0]].name, active: true },
    });
    await prisma.routeTransitPoint.createMany({
      data: stops.map(([stop, km], index) => ({ routeId: routeId(key), transitPointId: stations[stop], sequence: index + 1, distanceFromPreviousKm: index ? km : null })),
    });
    routes[key] = routeId(key);
  }
  log(`${routeKeys.length} two-way routes`);

  const officers: Network['officers'] = [];
  for (const [index, key] of stationKeys.entries()) {
    const officer = await prisma.user.create({
      data: { email: officerEmail(key), password, name: `${STATIONS[key].name} Station Officer`, phone: `0700${String(index + 1).padStart(6, '0')}`, role: UserRole.TRANSIT_OFFICER, address: STATIONS[key].address },
    });
    await prisma.transitPointOfficer.create({ data: { transitPointId: stations[key], officerId: officer.id } });
    await prisma.transitPoint.update({ where: { id: stations[key] }, data: { officerId: officer.id } });
    officers.push({ station: key, email: officer.email });
  }
  log(`${officers.length} station officers (one per station)`);

  for (const key of stationKeys) {
    const station = STATIONS[key];
    await prisma.lockerStation.create({
      data: {
        id: lockerStationId(key), name: `${station.name} Smart Lockers`, address: station.address, transitPointId: stations[key],
        latitude: station.latitude, longitude: station.longitude, openingHours: '06:00-22:00', active: true,
      },
    });
    const compartments = LOCKERS_PER_STATION.flatMap(([size, count, letter]) =>
      Array.from({ length: count }, (_, index) => ({ stationId: lockerStationId(key), compartmentNo: `${station.code}-${letter}${String(index + 1).padStart(2, '0')}`, size })),
    );
    await prisma.lockerCompartment.createMany({ data: compartments });
  }
  log(`${stationKeys.length * 40} lockers (40 per station: 16 small, 12 medium, 8 large, 4 extra large)`);

  const drivers: Network['drivers'] = [];
  for (const [routeIndex, key] of routeKeys.entries()) {
    for (const [seat, [vehicleType, maxLoadKg]] of FLEET.entries()) {
      const number = routeIndex * FLEET.length + seat + 1;
      const name = `${FIRST_NAMES[number % FIRST_NAMES.length]} ${LAST_NAMES[Math.floor(number / FIRST_NAMES.length) % LAST_NAMES.length]}`;
      const plate = `K${String.fromCharCode(65 + (number % 26))}${String.fromCharCode(65 + (seat % 26))} ${String(100 + number).slice(-3)}${vehicleType[0]}`;
      await prisma.user.create({
        data: {
          email: driverEmail(number), password, name, phone: `0710${String(number).padStart(6, '0')}`, role: UserRole.DRIVER,
          licenseNumber: `DL-${String(number).padStart(4, '0')}`, vehicleNumber: plate, vehicleType, maxLoadKg,
          isAvailable: true, driverApplicationStatus: 'APPROVED', driverApprovalDate: new Date(),
          driverProfile: { create: { routesServed: [routes[key]], approvalStatus: DriverStatus.APPROVED } },
        },
      });
      drivers.push({ email: driverEmail(number), route: key, vehicleType, maxLoadKg });
    }
  }
  log(`${drivers.length} drivers (10 per route: 2 motorcycles, 3 cars, 3 vans, 2 trucks)`);

  return { stations, routes, officers, drivers };
}
