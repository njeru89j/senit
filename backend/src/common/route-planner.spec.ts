import { RouteNetwork, haversineKm, validCoordinates } from './route-planner';

const P = {
  meru: { id: 'meru', name: 'Meru', latitude: 0.0463, longitude: 37.6559 },
  chuka: { id: 'chuka', name: 'Chuka', latitude: -0.3332, longitude: 37.6459 },
  thika: { id: 'thika', name: 'Thika', latitude: -1.0332, longitude: 37.0693 },
  juja: { id: 'juja', name: 'Juja', latitude: -1.1022, longitude: 37.0144 },
  nairobi: { id: 'nairobi', name: 'Nairobi', latitude: -1.2864, longitude: 36.8172 },
  ruaka: { id: 'ruaka', name: 'Ruaka', latitude: -1.2072, longitude: 36.7785 },
  kiambu: { id: 'kiambu', name: 'Kiambu', latitude: -1.1714, longitude: 36.8356 },
  embu: { id: 'embu', name: 'Embu', latitude: -0.5388, longitude: 37.4596 },
};
const stops = (routeId: string, ids: string[]) => ids.map((transitPointId, index) => ({ routeId, transitPointId, sequence: index + 1 }));

const network = new RouteNetwork(
  [
    { id: 'r1', name: 'Meru–Nairobi', active: true },
    { id: 'r2', name: 'Nairobi–Kiambu', active: true },
    { id: 'r3', name: 'Chuka–Embu', active: false },
  ],
  [...stops('r1', ['meru', 'chuka', 'thika', 'juja', 'nairobi']), ...stops('r2', ['nairobi', 'ruaka', 'kiambu']), ...stops('r3', ['chuka', 'embu'])],
  Object.values(P),
);
const legs = (from: string, to: string, net = network) => net.plan(from, to)?.map((leg) => [leg.routeId, leg.direction, leg.fromTransitPointId, leg.toTransitPointId]);

describe('route network', () => {
  it('uses only valid coordinates', () => {
    expect(validCoordinates(0, 0)).toBe(false);
    expect(validCoordinates(null, 36)).toBe(false);
    expect(validCoordinates(-1.2, 36.8)).toBe(true);
    expect(haversineKm(P.nairobi, P.juja)).toBeGreaterThan(25);
  });

  it('plans a direct journey in the reverse direction of a route (Nairobi → Juja)', () => {
    expect(legs('nairobi', 'juja')).toEqual([['r1', 'REVERSE', 'nairobi', 'juja']]);
  });

  it('plans one leg between intermediate stops (Chuka → Thika → Juja)', () => {
    const [leg] = network.plan('chuka', 'juja')!;
    expect(leg.stopIds).toEqual(['chuka', 'thika', 'juja']);
    expect(leg.direction).toBe('FORWARD');
  });

  it('transfers where routes share a station, without hardcoding it (Meru → Kiambu)', () => {
    expect(legs('meru', 'kiambu')).toEqual([['r1', 'FORWARD', 'meru', 'nairobi'], ['r2', 'FORWARD', 'nairobi', 'kiambu']]);
    expect(legs('chuka', 'kiambu')).toEqual([['r1', 'FORWARD', 'chuka', 'nairobi'], ['r2', 'FORWARD', 'nairobi', 'kiambu']]);
    expect(legs('ruaka', 'meru')).toEqual([['r2', 'REVERSE', 'ruaka', 'nairobi'], ['r1', 'REVERSE', 'nairobi', 'meru']]);
    expect(legs('thika', 'kiambu')).toEqual([['r1', 'FORWARD', 'thika', 'nairobi'], ['r2', 'FORWARD', 'nairobi', 'kiambu']]);
  });

  it('never plans onto an inactive route and reports no path', () => {
    expect(network.plan('chuka', 'embu')).toBeNull();
    expect(network.plan('meru', 'meru')).toEqual([]);
  });

  it('never boards or alights at an inactive station, but passes through it', () => {
    const withInactiveThika = new RouteNetwork(
      [{ id: 'r1', name: 'Meru–Nairobi', active: true }],
      stops('r1', ['meru', 'chuka', 'thika', 'juja', 'nairobi']),
      Object.values(P).map((point) => (point.id === 'thika' ? { ...point, active: false } : point)),
    );
    expect(withInactiveThika.plan('thika', 'juja')).toBeNull();
    expect(withInactiveThika.plan('chuka', 'juja')![0].stopIds).toEqual(['chuka', 'thika', 'juja']);
  });

  it('prefers a direct route over a shorter journey with a transfer', () => {
    const net = new RouteNetwork(
      [{ id: 'long', name: 'Long direct', active: true }, { id: 'a', name: 'A–X', active: true }, { id: 'b', name: 'X–C', active: true }],
      [
        { routeId: 'long', transitPointId: 'A', sequence: 1 }, { routeId: 'long', transitPointId: 'C', sequence: 2, distanceFromPreviousKm: 500 },
        { routeId: 'a', transitPointId: 'A', sequence: 1 }, { routeId: 'a', transitPointId: 'X', sequence: 2, distanceFromPreviousKm: 5 },
        { routeId: 'b', transitPointId: 'X', sequence: 1 }, { routeId: 'b', transitPointId: 'C', sequence: 2, distanceFromPreviousKm: 5 },
      ],
      ['A', 'X', 'C'].map((id) => ({ id, name: id })),
    );
    expect(legs('A', 'C', net)).toEqual([['long', 'FORWARD', 'A', 'C']]);
  });

  it('between equal transfer counts, prefers the shorter distance', () => {
    const net = new RouteNetwork(
      [{ id: 'a1', name: 'a1', active: true }, { id: 'a2', name: 'a2', active: true }, { id: 'b1', name: 'b1', active: true }, { id: 'b2', name: 'b2', active: true }],
      [
        { routeId: 'a1', transitPointId: 'S', sequence: 1 }, { routeId: 'a1', transitPointId: 'M1', sequence: 2, distanceFromPreviousKm: 50 },
        { routeId: 'a2', transitPointId: 'M1', sequence: 1 }, { routeId: 'a2', transitPointId: 'T', sequence: 2, distanceFromPreviousKm: 50 },
        { routeId: 'b1', transitPointId: 'S', sequence: 1 }, { routeId: 'b1', transitPointId: 'M2', sequence: 2, distanceFromPreviousKm: 10 },
        { routeId: 'b2', transitPointId: 'M2', sequence: 1 }, { routeId: 'b2', transitPointId: 'T', sequence: 2, distanceFromPreviousKm: 10 },
      ],
      ['S', 'M1', 'M2', 'T'].map((id) => ({ id, name: id })),
    );
    expect(legs('S', 'T', net)).toEqual([['b1', 'FORWARD', 'S', 'M2'], ['b2', 'FORWARD', 'M2', 'T']]);
  });

  it('supports journeys with more than two legs', () => {
    const net = new RouteNetwork(
      [{ id: 'x', name: 'x', active: true }, { id: 'y', name: 'y', active: true }, { id: 'z', name: 'z', active: true }],
      [...stops('x', ['A', 'B']), ...stops('y', ['B', 'C']), ...stops('z', ['C', 'D'])],
      ['A', 'B', 'C', 'D'].map((id) => ({ id, name: id })),
    );
    expect(legs('A', 'D', net)).toEqual([['x', 'FORWARD', 'A', 'B'], ['y', 'FORWARD', 'B', 'C'], ['z', 'FORWARD', 'C', 'D']]);
  });

  it('knows endpoints, directions, segments and distances in both directions', () => {
    expect(network.endpoints('r1')).toEqual(['meru', 'nairobi']);
    expect(network.directionFrom('r1', 'meru')).toBe('FORWARD');
    expect(network.directionFrom('r1', 'nairobi')).toBe('REVERSE');
    expect(network.directionFrom('r1', 'chuka')).toBeNull();
    expect(network.coversSegment('r1', 'FORWARD', 'chuka', 'juja')).toBe(true);
    expect(network.coversSegment('r1', 'FORWARD', 'chuka', 'meru')).toBe(false);
    const forward = network.segmentKm('r1', 'FORWARD', 'chuka', 'juja')!;
    const reverse = network.segmentKm('r1', 'REVERSE', 'juja', 'chuka')!;
    expect(forward).toBeCloseTo(reverse, 6);
    expect(network.stops('r1', 'REVERSE').map((stop) => stop.transitPointId)).toEqual(['nairobi', 'juja', 'thika', 'chuka', 'meru']);
  });

  it('uses configured road distances ahead of coordinates', () => {
    const net = new RouteNetwork([{ id: 'r', name: 'r', active: true }], [{ routeId: 'r', transitPointId: 'meru', sequence: 1 }, { routeId: 'r', transitPointId: 'chuka', sequence: 2, distanceFromPreviousKm: 64 }], [P.meru, P.chuka]);
    expect(net.routeLengthKm('r')).toBe(64);
  });

  it('is deterministic', () => {
    expect(network.plan('meru', 'kiambu')).toEqual(network.plan('meru', 'kiambu'));
  });
});
