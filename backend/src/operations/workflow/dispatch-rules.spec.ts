import { RouteNetwork } from '../../common/route-planner';
import { CandidateTrip, diagnoseNoDriver, evaluateTrip, rankEligible, vehicleCapacityKg } from './dispatch-rules';

const points = [
  { id: 'meru', name: 'Meru', latitude: 0.0463, longitude: 37.6559 },
  { id: 'chuka', name: 'Chuka', latitude: -0.3332, longitude: 37.6459 },
  { id: 'thika', name: 'Thika', latitude: -1.0332, longitude: 37.0693 },
  { id: 'juja', name: 'Juja', latitude: -1.1022, longitude: 37.0144 },
  { id: 'nairobi', name: 'Nairobi', latitude: -1.2864, longitude: 36.8172 },
];
const network = new RouteNetwork(
  [{ id: 'r1', name: 'Meru–Nairobi', active: true }, { id: 'off', name: 'Inactive', active: false }],
  [...['meru', 'chuka', 'thika', 'juja', 'nairobi'].map((transitPointId, index) => ({ routeId: 'r1', transitPointId, sequence: index + 1 })), { routeId: 'off', transitPointId: 'meru', sequence: 1 }, { routeId: 'off', transitPointId: 'chuka', sequence: 2 }],
  points,
);
const now = new Date('2026-09-21T10:00:00Z');
const trip = (overrides: Partial<CandidateTrip> = {}): CandidateTrip => ({
  tripId: 't1', driverId: 'd1', driverName: 'Driver', routeId: 'r1', direction: 'FORWARD', status: 'IN_TRANSIT',
  currentTransitPointId: 'meru', atStop: false, createdAt: new Date('2026-09-21T06:00:00Z'), capacityKg: 1500, reservedKg: 0, loadedKg: 0, ...overrides,
});
const chukaToJuja = { fromTransitPointId: 'chuka', toTransitPointId: 'juja', weightKg: 20 };

describe('assignment eligibility', () => {
  it('ranks a trip standing at the pickup as tier 1', () => {
    expect(evaluateTrip(network, trip({ status: 'CREATED', currentTransitPointId: 'meru', atStop: true }), { ...chukaToJuja, fromTransitPointId: 'meru' }, now)).toMatchObject({ eligible: true, tier: 1 });
    expect(evaluateTrip(network, trip({ currentTransitPointId: 'chuka', atStop: true }), chukaToJuja, now)).toMatchObject({ eligible: true, tier: 1 });
  });

  it('accepts an active trip that has not reached the pickup yet (mid-trip pickup)', () => {
    const result = evaluateTrip(network, trip({ currentTransitPointId: 'meru', atStop: false }), chukaToJuja, now);
    expect(result.eligible).toBe(true);
  });

  it('never assigns a pickup the trip has passed, by route order', () => {
    expect(evaluateTrip(network, trip({ currentTransitPointId: 'thika', atStop: true }), chukaToJuja, now)).toMatchObject({ eligible: false, reason: 'PICKUP_PASSED' });
    expect(evaluateTrip(network, trip({ currentTransitPointId: 'chuka', atStop: false }), chukaToJuja, now)).toMatchObject({ eligible: false, reason: 'PICKUP_PASSED' });
  });

  it('never assigns against the direction of travel, however close the driver is', () => {
    const nearChuka = { latitude: -0.34, longitude: 37.64, at: now };
    expect(evaluateTrip(network, trip({ direction: 'REVERSE', currentTransitPointId: 'nairobi', gps: nearChuka }), chukaToJuja, now)).toMatchObject({ eligible: false, reason: 'WRONG_ROUTE_OR_DIRECTION' });
    expect(evaluateTrip(network, trip(), { fromTransitPointId: 'chuka', toTransitPointId: 'meru', weightKg: 1 }, now)).toMatchObject({ eligible: false, reason: 'WRONG_ROUTE_OR_DIRECTION' });
  });

  it('uses a fresh GPS fix for the 10 km preference band and route distance otherwise', () => {
    const close = evaluateTrip(network, trip({ gps: { latitude: -0.30, longitude: 37.65, at: now } }), chukaToJuja, now);
    expect(close).toMatchObject({ eligible: true, tier: 2 });
    const far = evaluateTrip(network, trip({ gps: { latitude: -0.10, longitude: 37.655, at: now } }), chukaToJuja, now);
    expect(far).toMatchObject({ eligible: true, tier: 3 });
    const stale = evaluateTrip(network, trip({ gps: { latitude: -0.30, longitude: 37.65, at: new Date(now.getTime() - 60 * 60_000) } }), chukaToJuja, now);
    expect(stale).toMatchObject({ eligible: true, tier: 3 });
    if (stale.eligible) expect(stale.distanceKm).toBeGreaterThan(30);
  });

  it('excludes a driver whose fresh GPS fix is already beyond the pickup', () => {
    const betweenChukaAndThika = { latitude: -0.75, longitude: 37.3, at: now };
    expect(evaluateTrip(network, trip({ currentTransitPointId: 'meru', gps: betweenChukaAndThika }), chukaToJuja, now)).toMatchObject({ eligible: false, reason: 'PICKUP_PASSED' });
  });

  it('enforces remaining capacity (reserved plus loaded)', () => {
    expect(evaluateTrip(network, trip({ capacityKg: 100, reservedKg: 50, loadedKg: 40 }), chukaToJuja, now)).toMatchObject({ eligible: false, reason: 'INSUFFICIENT_CAPACITY' });
    expect(evaluateTrip(network, trip({ capacityKg: 100, reservedKg: 50, loadedKg: 30 }), chukaToJuja, now)).toMatchObject({ eligible: true, remainingKg: 20 });
  });

  it('respects declines, inactive routes and the motorcycle route limit', () => {
    expect(evaluateTrip(network, trip({ excluded: true }), chukaToJuja, now)).toMatchObject({ eligible: false, reason: 'DECLINED' });
    expect(evaluateTrip(network, trip({ routeId: 'off' }), chukaToJuja, now)).toMatchObject({ eligible: false, reason: 'ROUTE_INACTIVE' });
    expect(evaluateTrip(network, trip({ vehicleType: 'MOTORCYCLE', capacityKg: 100 }), chukaToJuja, now)).toMatchObject({ eligible: false, reason: 'MOTORCYCLE_ROUTE_TOO_LONG' });
  });

  it('ranks by tier, then distance, then spare capacity, then trip age, deterministically', () => {
    const atStation = evaluateTrip(network, trip({ tripId: 'a', currentTransitPointId: 'chuka', atStop: true }), chukaToJuja, now);
    const near = evaluateTrip(network, trip({ tripId: 'b', gps: { latitude: -0.30, longitude: 37.65, at: now } }), chukaToJuja, now);
    const farBig = evaluateTrip(network, trip({ tripId: 'c', capacityKg: 5000 }), chukaToJuja, now);
    const farSmall = evaluateTrip(network, trip({ tripId: 'd', capacityKg: 500 }), chukaToJuja, now);
    expect(rankEligible([farSmall, farBig, near, atStation]).map((item) => item.trip.tripId)).toEqual(['a', 'b', 'c', 'd']);
    const older = evaluateTrip(network, trip({ tripId: 'z', createdAt: new Date('2026-09-21T01:00:00Z') }), chukaToJuja, now);
    const newer = evaluateTrip(network, trip({ tripId: 'y' }), chukaToJuja, now);
    expect(rankEligible([newer, older]).map((item) => item.trip.tripId)).toEqual(['z', 'y']);
  });

  it('explains why no driver qualified', () => {
    const passed = evaluateTrip(network, trip({ currentTransitPointId: 'juja', atStop: true }), chukaToJuja, now);
    const full = evaluateTrip(network, trip({ capacityKg: 10 }), chukaToJuja, now);
    expect(diagnoseNoDriver({ anyOpenTrip: false, segmentServed: true, heavierThanAllVehicles: false, evaluations: [] })).toBe('NO_ACTIVE_DRIVERS');
    expect(diagnoseNoDriver({ anyOpenTrip: true, segmentServed: true, heavierThanAllVehicles: false, evaluations: [passed] })).toBe('ALL_PASSED_PICKUP');
    expect(diagnoseNoDriver({ anyOpenTrip: true, segmentServed: true, heavierThanAllVehicles: false, evaluations: [passed, full] })).toBe('INSUFFICIENT_CAPACITY');
    expect(diagnoseNoDriver({ anyOpenTrip: true, segmentServed: true, heavierThanAllVehicles: true, evaluations: [full] })).toBe('PARCEL_EXCEEDS_ALL_VEHICLES');
    expect(diagnoseNoDriver({ anyOpenTrip: true, segmentServed: false, heavierThanAllVehicles: false, evaluations: [] })).toBe('ROUTE_UNAVAILABLE');
  });

  it('normalises vehicle capacity to kilograms', () => {
    expect(vehicleCapacityKg({ vehicleType: 'TRUCK', maxLoadKg: 1500 })).toBe(1500);
    expect(vehicleCapacityKg({ vehicleType: 'MOTORCYCLE' })).toBe(15);
    expect(vehicleCapacityKg({ vehicleType: 'VAN', maxLoadKg: null })).toBe(1000);
  });
});
