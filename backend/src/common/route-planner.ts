/**
 * The delivery network as a graph, built only from database route data.
 *
 * Transit points are nodes. A route is an ordered list of stops (route_transit_points by sequence,
 * endpoints included) that can be travelled FORWARD (ascending sequence) or REVERSE (descending).
 * Consecutive stops on an active route are edges; a parcel may change route wherever two active
 * routes share a transit point. Nothing here knows about particular places or hubs.
 *
 * Journeys are planned with Dijkstra over (route, direction, stop) states using an ordered cost:
 * fewest transfers, then shortest distance, then legs on routes that have drivers, then fewest stops.
 */

export type Direction = 'FORWARD' | 'REVERSE';
export type NetworkRoute = { id: string; name: string; active?: boolean };
export type NetworkMembership = { routeId: string; transitPointId: string; sequence: number; distanceFromPreviousKm?: number | null };
export type NetworkPoint = { id: string; name: string; latitude?: number | null; longitude?: number | null; active?: boolean };

export type OrderedStop = {
  transitPointId: string;
  name: string;
  /** Position in travel order for the requested direction (0 = start endpoint). */
  index: number;
  active: boolean;
  latitude: number | null;
  longitude: number | null;
  /** Distance from the previous stop in this direction (0 for the first stop). */
  hopKm: number;
  /** True when hopKm comes from a configured distance or valid coordinates, not the network average. */
  distanceKnown: boolean;
  cumulativeKm: number;
};

export type PlannedLeg = {
  sequence: number;
  routeId: string;
  routeName: string;
  direction: Direction;
  fromTransitPointId: string;
  toTransitPointId: string;
  fromName: string;
  toName: string;
  distanceKm: number;
  /** Every stop the parcel passes on this leg, in travel order, both ends included. */
  stopIds: string[];
};

export type PlanOptions = { servedRouteIds?: Set<string> };

const EARTH_RADIUS_KM = 6371;
const DEFAULT_HOP_KM = 10;

export function validCoordinates(latitude?: number | null, longitude?: number | null): boolean {
  if (latitude == null || longitude == null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude === 0 && longitude === 0) return false;
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLng = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

type Cost = [transfers: number, km: number, unservedLegs: number, stops: number];
const lessThan = (a: Cost, b: Cost) => {
  for (let i = 0; i < a.length; i++) {
    const diff = i === 1 ? Math.round((a[i] - b[i]) * 1000) / 1000 : a[i] - b[i];
    if (diff !== 0) return diff < 0;
  }
  return false;
};

type State = { routeId: string; direction: Direction; index: number };
const stateKey = (state: State) => `${state.routeId}|${state.direction}|${state.index}`;

export class RouteNetwork {
  private readonly routeById = new Map<string, NetworkRoute>();
  private readonly pointById = new Map<string, NetworkPoint>();
  private readonly forward = new Map<string, OrderedStop[]>();
  private readonly reverse = new Map<string, OrderedStop[]>();
  readonly averageHopKm: number;

  constructor(routes: NetworkRoute[], memberships: NetworkMembership[], points: NetworkPoint[]) {
    for (const route of routes) this.routeById.set(route.id, route);
    for (const point of points) this.pointById.set(point.id, point);

    const ordered = new Map<string, NetworkMembership[]>();
    for (const membership of memberships) {
      if (!this.routeById.has(membership.routeId) || !this.pointById.has(membership.transitPointId)) continue;
      ordered.set(membership.routeId, [...(ordered.get(membership.routeId) ?? []), membership]);
    }

    // Known hop distances feed the fallback for hops with neither a configured distance nor coordinates.
    const known: number[] = [];
    const rawHops = new Map<string, Array<number | null>>();
    for (const [routeId, list] of ordered) {
      list.sort((a, b) => a.sequence - b.sequence);
      const hops = list.map((membership, index) => {
        if (index === 0) return 0;
        if (membership.distanceFromPreviousKm != null && membership.distanceFromPreviousKm >= 0) return membership.distanceFromPreviousKm;
        const from = this.pointById.get(list[index - 1].transitPointId)!;
        const to = this.pointById.get(membership.transitPointId)!;
        return validCoordinates(from.latitude, from.longitude) && validCoordinates(to.latitude, to.longitude)
          ? haversineKm({ latitude: from.latitude!, longitude: from.longitude! }, { latitude: to.latitude!, longitude: to.longitude! })
          : null;
      });
      hops.slice(1).forEach((hop) => { if (hop != null) known.push(hop); });
      rawHops.set(routeId, hops);
    }
    this.averageHopKm = known.length ? known.reduce((sum, hop) => sum + hop, 0) / known.length : DEFAULT_HOP_KM;

    for (const [routeId, list] of ordered) {
      const hops = rawHops.get(routeId)!;
      const build = (sequence: NetworkMembership[], hopFor: (position: number) => number | null): OrderedStop[] => {
        let cumulative = 0;
        return sequence.map((membership, index) => {
          const point = this.pointById.get(membership.transitPointId)!;
          const raw = index === 0 ? 0 : hopFor(index);
          const hopKm = raw ?? this.averageHopKm;
          cumulative += hopKm;
          return {
            transitPointId: point.id,
            name: point.name,
            index,
            active: point.active !== false,
            latitude: validCoordinates(point.latitude, point.longitude) ? point.latitude! : null,
            longitude: validCoordinates(point.latitude, point.longitude) ? point.longitude! : null,
            hopKm,
            distanceKnown: index === 0 || raw != null,
            cumulativeKm: cumulative,
          };
        });
      };
      this.forward.set(routeId, build(list, (index) => hops[index]));
      // Reverse travel crosses the same hops backwards: hop into reversed position i is forward hop (n - i).
      const reversed = [...list].reverse();
      this.reverse.set(routeId, build(reversed, (index) => hops[list.length - index]));
    }
  }

  route(routeId: string): NetworkRoute | undefined {
    return this.routeById.get(routeId);
  }

  point(transitPointId: string): NetworkPoint | undefined {
    return this.pointById.get(transitPointId);
  }

  routes(): NetworkRoute[] {
    return [...this.routeById.values()];
  }

  isRouteUsable(routeId: string): boolean {
    return this.routeById.get(routeId)?.active !== false && this.stops(routeId).length >= 2;
  }

  /** Stops in travel order for a direction. */
  stops(routeId: string, direction: Direction = 'FORWARD'): OrderedStop[] {
    return (direction === 'FORWARD' ? this.forward : this.reverse).get(routeId) ?? [];
  }

  /** The route's two endpoints in FORWARD order. */
  endpoints(routeId: string): [string, string] | null {
    const stops = this.stops(routeId);
    return stops.length >= 2 ? [stops[0].transitPointId, stops[stops.length - 1].transitPointId] : null;
  }

  /** The direction a trip travels when it starts at an endpoint, or null for a non-endpoint. */
  directionFrom(routeId: string, startTransitPointId: string): Direction | null {
    const ends = this.endpoints(routeId);
    if (!ends) return null;
    if (ends[0] === startTransitPointId) return 'FORWARD';
    if (ends[1] === startTransitPointId) return 'REVERSE';
    return null;
  }

  indexOf(routeId: string, direction: Direction, transitPointId: string): number {
    return this.stops(routeId, direction).findIndex((stop) => stop.transitPointId === transitPointId);
  }

  /** True when travelling the route in this direction passes `from` and then `to`. */
  coversSegment(routeId: string, direction: Direction, fromTransitPointId: string, toTransitPointId: string): boolean {
    const from = this.indexOf(routeId, direction, fromTransitPointId);
    const to = this.indexOf(routeId, direction, toTransitPointId);
    return from >= 0 && to > from;
  }

  /** Distance travelled between two stops in travel order (null when not in order on the route). */
  segmentKm(routeId: string, direction: Direction, fromTransitPointId: string, toTransitPointId: string): number | null {
    const stops = this.stops(routeId, direction);
    const from = stops.findIndex((stop) => stop.transitPointId === fromTransitPointId);
    const to = stops.findIndex((stop) => stop.transitPointId === toTransitPointId);
    if (from < 0 || to < from) return null;
    return stops[to].cumulativeKm - stops[from].cumulativeKm;
  }

  routeLengthKm(routeId: string): number {
    const stops = this.stops(routeId);
    return stops.length ? stops[stops.length - 1].cumulativeKm : 0;
  }

  /** Active routes (with direction) whose travel passes `from` then `to`. */
  routesCovering(fromTransitPointId: string, toTransitPointId: string): Array<{ routeId: string; direction: Direction }> {
    const result: Array<{ routeId: string; direction: Direction }> = [];
    for (const route of this.routeById.values()) {
      if (!this.isRouteUsable(route.id)) continue;
      for (const direction of ['FORWARD', 'REVERSE'] as Direction[]) {
        if (this.coversSegment(route.id, direction, fromTransitPointId, toTransitPointId)) result.push({ routeId: route.id, direction });
      }
    }
    return result;
  }

  /**
   * Plans a journey between two stations. Returns [] when they are the same station and null when no
   * active route connection exists. Inactive stations are passed through but never boarded, alighted or
   * used as transfer points.
   */
  plan(fromTransitPointId: string, toTransitPointId: string, options: PlanOptions = {}): PlannedLeg[] | null {
    if (fromTransitPointId === toTransitPointId) return [];
    const from = this.pointById.get(fromTransitPointId);
    const to = this.pointById.get(toTransitPointId);
    if (!from || !to || from.active === false || to.active === false) return null;
    const served = options.servedRouteIds;
    const unserved = (routeId: string) => (served && !served.has(routeId) ? 1 : 0);

    const cost = new Map<string, Cost>();
    const previous = new Map<string, State | null>();
    const states = new Map<string, State>();
    const done = new Set<string>();
    const starts = new Set<string>();

    for (const route of this.routeById.values()) {
      if (!this.isRouteUsable(route.id)) continue;
      for (const direction of ['FORWARD', 'REVERSE'] as Direction[]) {
        const stops = this.stops(route.id, direction);
        const index = stops.findIndex((stop) => stop.transitPointId === fromTransitPointId);
        if (index < 0 || index === stops.length - 1) continue;
        const state = { routeId: route.id, direction, index };
        const key = stateKey(state);
        states.set(key, state);
        cost.set(key, [0, 0, unserved(route.id), 0]);
        previous.set(key, null);
        starts.add(key);
      }
    }

    while (true) {
      let currentKey: string | undefined;
      for (const [key, value] of cost) {
        if (!done.has(key) && (currentKey === undefined || lessThan(value, cost.get(currentKey)!))) currentKey = key;
      }
      if (currentKey === undefined) return null;
      done.add(currentKey);
      const current = states.get(currentKey)!;
      const currentCost = cost.get(currentKey)!;
      const stops = this.stops(current.routeId, current.direction);
      const here = stops[current.index];
      if (!starts.has(currentKey) && here.transitPointId === toTransitPointId) return this.toLegs(currentKey, previous, states);

      const relax = (next: State, step: Cost) => {
        const key = stateKey(next);
        if (done.has(key)) return;
        const candidate: Cost = [currentCost[0] + step[0], currentCost[1] + step[1], currentCost[2] + step[2], currentCost[3] + step[3]];
        if (!cost.has(key) || lessThan(candidate, cost.get(key)!)) {
          cost.set(key, candidate);
          previous.set(key, current);
          states.set(key, next);
        }
      };

      if (current.index + 1 < stops.length) {
        relax({ ...current, index: current.index + 1 }, [0, stops[current.index + 1].hopKm, 0, 1]);
      }
      // Changing route happens only at an active station that is not where the parcel boarded this route.
      if (here.active && !starts.has(currentKey)) {
        for (const route of this.routeById.values()) {
          if (route.id === current.routeId || !this.isRouteUsable(route.id)) continue;
          for (const direction of ['FORWARD', 'REVERSE'] as Direction[]) {
            const otherStops = this.stops(route.id, direction);
            const index = otherStops.findIndex((stop) => stop.transitPointId === here.transitPointId);
            if (index < 0 || index === otherStops.length - 1) continue;
            relax({ routeId: route.id, direction, index }, [1, 0, unserved(route.id), 0]);
          }
        }
      }
    }
  }

  private toLegs(goalKey: string, previous: Map<string, State | null>, states: Map<string, State>): PlannedLeg[] {
    const path: State[] = [];
    for (let state: State | null | undefined = states.get(goalKey); state; state = previous.get(stateKey(state))) path.unshift(state);
    const legs: PlannedLeg[] = [];
    let start = 0;
    for (let i = 1; i <= path.length; i++) {
      const boundary = i === path.length || path[i].routeId !== path[start].routeId || path[i].direction !== path[start].direction;
      if (!boundary) continue;
      const first = path[start];
      const last = path[i - 1];
      if (last.index > first.index) {
        const stops = this.stops(first.routeId, first.direction);
        legs.push({
          sequence: legs.length + 1,
          routeId: first.routeId,
          routeName: this.routeById.get(first.routeId)?.name ?? 'Route',
          direction: first.direction,
          fromTransitPointId: stops[first.index].transitPointId,
          toTransitPointId: stops[last.index].transitPointId,
          fromName: stops[first.index].name,
          toName: stops[last.index].name,
          distanceKm: Math.round((stops[last.index].cumulativeKm - stops[first.index].cumulativeKm) * 10) / 10,
          stopIds: stops.slice(first.index, last.index + 1).map((stop) => stop.transitPointId),
        });
      }
      start = i;
    }
    return legs;
  }

  describe(legs: PlannedLeg[]): string {
    return legs.map((leg) => `${leg.routeName} (${leg.fromName} → ${leg.toName})`).join(', then ');
  }
}
