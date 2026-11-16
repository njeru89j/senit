import { Direction, RouteNetwork, haversineKm } from '../../common/route-planner';

/** Driver acceptance window for an automatic assignment. Enforced server-side. */
export const ACCEPTANCE_WINDOW_MS = 3 * 60 * 60 * 1000;
/** Station collection window after final verification. */
export const STATION_COLLECTION_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Preference band for approaching drivers; not a hard limit. */
export const NEAR_BAND_KM = 10;
/** A GPS fix older than this is ignored and the driver is ranked by route position only. */
export const GPS_FRESH_MS = 15 * 60 * 1000;
/** Distance beyond which a fresh fix between the pickup and the next stop means the pickup is behind. */
export const PASSED_PICKUP_GPS_KM = 2;
/** Motorcycles are limited to short routes (existing policy). */
export const MOTORCYCLE_MAX_ROUTE_KM = 80;

/** Deadlines in messages, histories and emails are shown in Kenyan time, e.g. "22 Sep 2026, 15:15 EAT". */
export function formatDeadline(date: Date): string {
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)} EAT`;
}

const DEFAULT_CAPACITY_KG: Record<string, number> = { MOTORCYCLE: 15, CAR: 300, VAN: 1000, TRUCK: 1500 };

/** Maximum load in kg: the configured vehicle capacity, else the vehicle type's default. */
export function vehicleCapacityKg(driver: { vehicleType?: string | null; maxLoadKg?: number | null }): number {
  if (driver.maxLoadKg && driver.maxLoadKg > 0) return driver.maxLoadKg;
  return DEFAULT_CAPACITY_KG[driver.vehicleType ?? ''] ?? 1500;
}

export type CandidateTrip = {
  tripId: string;
  driverId: string;
  driverName: string;
  routeId: string;
  direction: Direction;
  status: 'CREATED' | 'IN_TRANSIT';
  currentTransitPointId: string;
  atStop: boolean;
  createdAt: Date;
  vehicleType?: string | null;
  capacityKg: number;
  reservedKg: number;
  loadedKg: number;
  gps?: { latitude: number; longitude: number; at: Date } | null;
  /** The driver rejected, let expire, or was cancelled from this leg on this trip. */
  excluded?: boolean;
};

export type LegRequest = { fromTransitPointId: string; toTransitPointId: string; weightKg: number };

export type IneligibleReason =
  | 'ROUTE_INACTIVE'
  | 'WRONG_ROUTE_OR_DIRECTION'
  | 'PICKUP_PASSED'
  | 'INSUFFICIENT_CAPACITY'
  | 'DECLINED'
  | 'MOTORCYCLE_ROUTE_TOO_LONG';

export type Evaluation =
  | { eligible: true; trip: CandidateTrip; tier: 1 | 2 | 3; distanceKm: number | null; remainingKg: number }
  | { eligible: false; trip: CandidateTrip; reason: IneligibleReason };

/**
 * Decides whether a trip can take a leg and how it ranks. Route position decides first:
 * the trip must travel pickup then drop-off, and the pickup must still be ahead. GPS can only
 * exclude a driver (fresh fix already beyond the pickup) and refine distance, never include one.
 */
export function evaluateTrip(network: RouteNetwork, trip: CandidateTrip, leg: LegRequest, now = new Date()): Evaluation {
  if (!network.isRouteUsable(trip.routeId)) return { eligible: false, trip, reason: 'ROUTE_INACTIVE' };
  const stops = network.stops(trip.routeId, trip.direction);
  const pickup = stops.findIndex((stop) => stop.transitPointId === leg.fromTransitPointId);
  const drop = stops.findIndex((stop) => stop.transitPointId === leg.toTransitPointId);
  if (pickup < 0 || drop <= pickup) return { eligible: false, trip, reason: 'WRONG_ROUTE_OR_DIRECTION' };

  const current = trip.status === 'CREATED' ? 0 : stops.findIndex((stop) => stop.transitPointId === trip.currentTransitPointId);
  if (current < 0) return { eligible: false, trip, reason: 'WRONG_ROUTE_OR_DIRECTION' };
  const standingAtPickup = pickup === current && (trip.status === 'CREATED' || trip.atStop);
  if (pickup < current || (pickup === current && !standingAtPickup)) return { eligible: false, trip, reason: 'PICKUP_PASSED' };

  const gpsFresh = !!trip.gps && now.getTime() - trip.gps.at.getTime() <= GPS_FRESH_MS;
  const pickupStop = stops[pickup];
  const pickupCoords = pickupStop.latitude != null && pickupStop.longitude != null ? { latitude: pickupStop.latitude, longitude: pickupStop.longitude } : null;
  if (trip.status === 'IN_TRANSIT' && !standingAtPickup && gpsFresh && pickupCoords && pickup + 1 < stops.length) {
    const next = stops[pickup + 1];
    if (next.latitude != null && next.longitude != null) {
      const nextCoords = { latitude: next.latitude, longitude: next.longitude };
      const fromDriver = haversineKm(trip.gps!, pickupCoords);
      if (fromDriver > PASSED_PICKUP_GPS_KM && haversineKm(trip.gps!, nextCoords) < haversineKm(pickupCoords, nextCoords)) {
        return { eligible: false, trip, reason: 'PICKUP_PASSED' };
      }
    }
  }

  if (trip.excluded) return { eligible: false, trip, reason: 'DECLINED' };
  if (trip.vehicleType === 'MOTORCYCLE' && network.routeLengthKm(trip.routeId) > MOTORCYCLE_MAX_ROUTE_KM) {
    return { eligible: false, trip, reason: 'MOTORCYCLE_ROUTE_TOO_LONG' };
  }
  const remainingKg = trip.capacityKg - trip.reservedKg - trip.loadedKg;
  if (remainingKg + 1e-9 < leg.weightKg) return { eligible: false, trip, reason: 'INSUFFICIENT_CAPACITY' };

  if (standingAtPickup) return { eligible: true, trip, tier: 1, distanceKm: 0, remainingKg };
  let distanceKm: number | null = null;
  if (gpsFresh && pickupCoords) distanceKm = haversineKm(trip.gps!, pickupCoords);
  else {
    const allKnown = stops.slice(current + 1, pickup + 1).every((stop) => stop.distanceKnown);
    if (allKnown) distanceKm = stops[pickup].cumulativeKm - stops[current].cumulativeKm;
  }
  const tier = distanceKm != null && distanceKm <= NEAR_BAND_KM ? 2 : 3;
  return { eligible: true, trip, tier, distanceKm, remainingKg };
}

/** Deterministic ranking: tier, then nearest, then most spare capacity, then oldest trip, then id. */
export function rankEligible(evaluations: Evaluation[]): Array<Extract<Evaluation, { eligible: true }>> {
  const eligible = evaluations.filter((item): item is Extract<Evaluation, { eligible: true }> => item.eligible);
  return eligible.sort((a, b) =>
    a.tier - b.tier
    || (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY)
    || b.remainingKg - a.remainingKg
    || a.trip.createdAt.getTime() - b.trip.createdAt.getTime()
    || a.trip.tripId.localeCompare(b.trip.tripId));
}

export type NoDriverReason =
  | 'NO_ACTIVE_DRIVERS'
  | 'NO_OPEN_TRIP_ON_SEGMENT'
  | 'ALL_PASSED_PICKUP'
  | 'INSUFFICIENT_CAPACITY'
  | 'PARCEL_EXCEEDS_ALL_VEHICLES'
  | 'ALL_DECLINED'
  | 'ROUTE_UNAVAILABLE';

export const NO_DRIVER_MESSAGES: Record<NoDriverReason, string> = {
  NO_ACTIVE_DRIVERS: 'No driver currently has an open trip on the network.',
  NO_OPEN_TRIP_ON_SEGMENT: 'No open trip on a compatible route is heading toward this leg.',
  ALL_PASSED_PICKUP: 'Every compatible driver has already passed the pickup station.',
  INSUFFICIENT_CAPACITY: 'Compatible drivers do not have enough spare vehicle capacity.',
  PARCEL_EXCEEDS_ALL_VEHICLES: 'The parcel is heavier than any vehicle serving this route can carry.',
  ALL_DECLINED: 'Every compatible driver on the current trips has declined or let the offer expire.',
  ROUTE_UNAVAILABLE: 'No active route currently serves this leg.',
};

/** Why nothing qualified, from the most specific reason that applies. */
export function diagnoseNoDriver(input: {
  anyOpenTrip: boolean;
  segmentServed: boolean;
  heavierThanAllVehicles: boolean;
  evaluations: Evaluation[];
}): NoDriverReason {
  if (!input.segmentServed) return 'ROUTE_UNAVAILABLE';
  if (input.heavierThanAllVehicles) return 'PARCEL_EXCEEDS_ALL_VEHICLES';
  if (!input.anyOpenTrip) return 'NO_ACTIVE_DRIVERS';
  const onSegment = input.evaluations.filter((item) => !item.eligible && item.reason !== 'WRONG_ROUTE_OR_DIRECTION' && item.reason !== 'ROUTE_INACTIVE');
  if (!onSegment.length) return 'NO_OPEN_TRIP_ON_SEGMENT';
  const reasons = new Set(onSegment.map((item) => (item.eligible ? '' : item.reason)));
  if (reasons.has('INSUFFICIENT_CAPACITY')) return 'INSUFFICIENT_CAPACITY';
  if (reasons.has('DECLINED')) return 'ALL_DECLINED';
  if (reasons.has('PICKUP_PASSED')) return 'ALL_PASSED_PICKUP';
  return 'NO_OPEN_TRIP_ON_SEGMENT';
}
