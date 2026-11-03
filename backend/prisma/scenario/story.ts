/**
 * "A day on the corridor": the scripted scenario played through the real workflow services.
 * The seed runs it to leave a realistic demo state in every queue; the e2e suite runs the same
 * script and asserts each outcome.
 *
 *  P1  Meru → Kiambu, smart locker   Peter (truck) Meru→Nairobi, transfer at Nairobi, Grace (van) Nairobi→Kiambu,
 *                                    locker reserved and placed at Kiambu → code sent to Brian        → in_locker
 *  P2  Meru → Juja, station           rides Peter's trip, dropped at Juja (route endpoint is Nairobi),
 *                                    verified, collected by Carol at the counter                      → delivered
 *  P3  Chuka → Juja, station          confirmed after Peter's trip started; Peter picks it up mid-trip  → at_destination (guest collects with ID)
 *  P4  Nairobi → Juja, station        reverse direction; no Nairobi→Meru trip is open                   → waiting for a driver
 *  P5  Meru → Nairobi                 offered to John, who rejects; reassigned to Mary                  → offer pending (3-hour window)
 *  P7  Kiambu → Nakuru                booked online, not yet handed over (two-leg journey planned)      → awaiting drop-off
 *  P8  Nairobi → Nakuru               Samuel's trip; not found at Nakuru on hand-over                  → missing exception
 *  P9  Nairobi → Naivasha             Samuel's trip; received damaged at Naivasha                      → damaged exception
 */
import { AssignmentStatus, UserRole } from '@prisma/client';
import { CUSTOMERS, CustomerKey, DriverKey, GUEST, RouteKey, ScenarioNetwork, StationKey, STATIONS } from './network';
import { WorkflowServices } from './services';

export type StoryResult = {
  parcels: Record<'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P7' | 'P8' | 'P9', string>;
  trips: Record<'peter' | 'grace' | 'john' | 'mary' | 'samuel' | 'joseph', string>;
  steps: string[];
};

export function scenarioHelpers(s: WorkflowServices, net: ScenarioNetwork) {
  const officer = (station: StationKey) => ({ id: net.officers[station].id, role: UserRole.TRANSIT_OFFICER });
  const driverId = (key: DriverKey) => net.drivers[key].id;
  const book = async (customer: CustomerKey, data: { to: CustomerKey | 'guest'; from: StationKey; dest: StationKey; weight: number; method?: 'STATION_COLLECTION' | 'SMART_LOCKER'; description: string }) => {
    const recipient = data.to === 'guest' ? GUEST : { name: CUSTOMERS[data.to].name, email: net.customers[data.to].email, phone: CUSTOMERS[data.to].phone };
    const parcel = await s.parcels.create({
      recipientName: recipient.name, recipientEmail: recipient.email, recipientPhone: recipient.phone,
      pickupTransitPointId: net.stations[data.from], destinationTransitPointId: net.stations[data.dest],
      weight: data.weight, collectionMethod: data.method ?? 'STATION_COLLECTION', category: 'OTHER', description: data.description,
    } as any, net.customers[customer].id, 'CUSTOMER');
    return parcel.id;
  };
  const offer = async (parcelId: string, statuses: AssignmentStatus[] = [AssignmentStatus.ASSIGNED, AssignmentStatus.ACCEPTED]) =>
    s.prisma.parcelAssignment.findFirstOrThrow({ where: { parcelId, status: { in: statuses } }, orderBy: { assignedAt: 'desc' } });
  const openTrip = async (driver: DriverKey, route: RouteKey, start: StationKey) => {
    const workspace = await s.trips.openTrip(driverId(driver), { routeId: net.routes[route], startTransitPointId: net.stations[start] });
    return workspace.trip!.id as string;
  };
  const gps = (driver: DriverKey, latitude: number, longitude: number) =>
    s.prisma.user.update({ where: { id: driverId(driver) }, data: { currentLat: latitude, currentLng: longitude, lastActiveAt: new Date() } });
  const at = (station: StationKey) => STATIONS[station];
  const acceptAndCollect = async (parcelId: string, driver: DriverKey) => {
    const assignment = await offer(parcelId);
    if (assignment.driverId !== driverId(driver)) throw new Error(`Expected ${driver} to be offered ${parcelId}`);
    await s.dispatch.accept(assignment.id, driverId(driver));
    await s.trips.collect(assignment.id, driverId(driver));
  };
  return { officer, driverId, book, offer, openTrip, gps, at, acceptAndCollect };
}

export async function runCorridorStory(s: WorkflowServices, net: ScenarioNetwork, log: (line: string) => void = () => undefined): Promise<StoryResult> {
  const { officer, driverId, book, offer, openTrip, gps, at, acceptAndCollect } = scenarioHelpers(s, net);
  const steps: string[] = [];
  const step = (line: string) => { steps.push(line); log(line); };

  // Peter prepares a Meru → Nairobi truck run.
  await gps('peter', at('meru').latitude, at('meru').longitude);
  const peterTrip = await openTrip('peter', 'meruNairobi', 'meru');
  step('Peter opened a Meru → Nairobi trip (truck, 1,500 kg).');

  const P1 = await book('alice', { to: 'brian', from: 'meru', dest: 'kiambu', weight: 12, method: 'SMART_LOCKER', description: 'P1 · Textbooks for Brian (Meru → Kiambu, smart locker)' });
  await s.journey.confirmAtOrigin(P1, officer('meru'));
  await acceptAndCollect(P1, 'peter');
  step('P1 Meru → Kiambu confirmed at Meru, auto-assigned to Peter (at the station), accepted and collected.');

  const P2 = await book('alice', { to: 'carol', from: 'meru', dest: 'juja', weight: 40, description: 'P2 · Miraa crates for Carol (Meru → Juja)' });
  await s.journey.confirmAtOrigin(P2, officer('meru'));
  await acceptAndCollect(P2, 'peter');
  step('P2 Meru → Juja confirmed and collected by Peter; Juja is before his route endpoint.');

  await s.trips.startTrip(peterTrip, driverId('peter'));
  await gps('peter', -0.28, 37.652);
  step('Peter pressed Start Delivery; P1 and P2 are in transit. He is approaching Chuka.');

  const P3 = await book('carol', { to: 'guest', from: 'chuka', dest: 'juja', weight: 5, description: 'P3 · Documents for a guest recipient (Chuka → Juja)' });
  await s.journey.confirmAtOrigin(P3, officer('chuka'));
  const p3Offer = await offer(P3);
  await s.dispatch.accept(p3Offer.id, driverId('peter'));
  await s.trips.arrive(peterTrip, driverId('peter'), net.stations.chuka);
  await s.trips.collect(p3Offer.id, driverId('peter'));
  await s.trips.depart(peterTrip, driverId('peter'));
  step('P3 Chuka → Juja confirmed after departure; offered to Peter (approaching, not passed), collected at Chuka mid-trip.');

  await gps('peter', at('juja').latitude, at('juja').longitude);
  await s.trips.arrive(peterTrip, driverId('peter'), net.stations.juja);
  await s.trips.drop(peterTrip, driverId('peter'));
  await s.verification.verify(officer('juja'), { transitPointId: net.stations.juja, items: [{ parcelId: P2, outcome: 'VERIFIED' }, { parcelId: P3, outcome: 'VERIFIED' }] });
  step('Thika was passed without activity. At Juja Peter dropped P2 and P3; the Juja officer batch-verified both.');

  await s.collection.counterHandover(P2, { id: net.customers.carol.id, role: UserRole.CUSTOMER });
  step('Carol collected P2 at the Juja counter within the 12-hour window → delivered.');

  await s.trips.depart(peterTrip, driverId('peter'));
  await gps('peter', at('nairobi').latitude, at('nairobi').longitude);
  await s.trips.arrive(peterTrip, driverId('peter'), net.stations.nairobi);
  await s.trips.complete(peterTrip, driverId('peter'));
  await s.verification.verify(officer('nairobi'), { transitPointId: net.stations.nairobi, items: [{ parcelId: P1, outcome: 'VERIFIED' }] });
  step('Peter completed his trip at Nairobi (route endpoint). Nairobi verified P1: leg 1 done, connecting leg to Kiambu waiting.');

  await gps('grace', at('nairobi').latitude, at('nairobi').longitude);
  const graceTrip = await openTrip('grace', 'nairobiKiambu', 'nairobi');
  await acceptAndCollect(P1, 'grace');
  await s.trips.startTrip(graceTrip, driverId('grace'));
  await s.trips.arrive(graceTrip, driverId('grace'), net.stations.kiambu);
  await s.trips.complete(graceTrip, driverId('grace'));
  await s.verification.verify(officer('kiambu'), { transitPointId: net.stations.kiambu, items: [{ parcelId: P1, outcome: 'VERIFIED' }] });
  const reservation = await s.prisma.lockerAssignment.findFirstOrThrow({ where: { parcelId: P1, cancelledAt: null } });
  await s.collection.confirmPlaced(reservation.id, officer('kiambu'));
  step('Grace opened Nairobi → Kiambu and was assigned P1 automatically; Kiambu verified it, a locker was reserved and placed; Brian received the code.');

  const P4 = await book('brian', { to: 'alice', from: 'nairobi', dest: 'juja', weight: 8, description: 'P4 · Phone accessories (Nairobi → Juja, reverse direction)' });
  await s.journey.confirmAtOrigin(P4, officer('nairobi'));
  step('P4 Nairobi → Juja confirmed; no Nairobi → Meru trip is open, so it waits for a driver and the officer is alerted.');

  await gps('john', at('meru').latitude, at('meru').longitude);
  await gps('mary', at('meru').latitude, at('meru').longitude);
  const johnTrip = await openTrip('john', 'meruNairobi', 'meru');
  const maryTrip = await openTrip('mary', 'meruNairobi', 'meru');
  const P5 = await book('alice', { to: 'brian', from: 'meru', dest: 'nairobi', weight: 30, description: 'P5 · Avocado box (Meru → Nairobi)' });
  await s.journey.confirmAtOrigin(P5, officer('meru'));
  const johnOffer = await offer(P5);
  await s.dispatch.reject(johnOffer.id, driverId('john'), 'Vehicle is booked for a full private load today');
  step('P5 Meru → Nairobi was offered to John (most spare capacity); John rejected, so it was reassigned to Mary, who has 3 hours to accept.');

  const P7 = await book('brian', { to: 'alice', from: 'kiambu', dest: 'nakuru', weight: 3, description: 'P7 · Gift parcel (Kiambu → Nakuru, two legs, not yet handed over)' });
  step('P7 Kiambu → Nakuru booked online; waiting for Brian to hand it over at Kiambu.');

  await gps('samuel', at('nairobi').latitude, at('nairobi').longitude);
  const samuelTrip = await openTrip('samuel', 'nairobiNakuru', 'nairobi');
  const P8 = await book('alice', { to: 'brian', from: 'nairobi', dest: 'nakuru', weight: 10, description: 'P8 · Spare parts (Nairobi → Nakuru)' });
  const P9 = await book('carol', { to: 'alice', from: 'nairobi', dest: 'naivasha', weight: 6, description: 'P9 · Glassware (Nairobi → Naivasha)' });
  await s.journey.confirmAtOrigin(P8, officer('nairobi'));
  await s.journey.confirmAtOrigin(P9, officer('nairobi'));
  await acceptAndCollect(P8, 'samuel');
  await acceptAndCollect(P9, 'samuel');
  await s.trips.startTrip(samuelTrip, driverId('samuel'));
  await s.trips.arrive(samuelTrip, driverId('samuel'), net.stations.naivasha);
  await s.trips.drop(samuelTrip, driverId('samuel'));
  await s.verification.verify(officer('naivasha'), { transitPointId: net.stations.naivasha, items: [{ parcelId: P9, outcome: 'DAMAGED', notes: 'Box crushed on one corner; contents rattle' }] });
  await s.trips.depart(samuelTrip, driverId('samuel'));
  await s.trips.arrive(samuelTrip, driverId('samuel'), net.stations.nakuru);
  await s.trips.complete(samuelTrip, driverId('samuel'));
  await s.verification.verify(officer('nakuru'), { transitPointId: net.stations.nakuru, items: [{ parcelId: P8, outcome: 'MISSING', notes: 'Not on the vehicle at hand-over' }] });
  step('Samuel carried P8 and P9 toward Nakuru: P9 was received damaged at Naivasha, P8 was missing at Nakuru. Both are in the exception queues.');

  await gps('joseph', at('kiambu').latitude, at('kiambu').longitude);
  const josephTrip = await openTrip('joseph', 'nairobiKiambu', 'kiambu');
  step('Joseph (motorcycle, 15 kg) opened a Kiambu → Nairobi trip and is available for small parcels.');

  return {
    parcels: { P1, P2, P3, P4, P5, P7, P8, P9 },
    trips: { peter: peterTrip, grace: graceTrip, john: johnTrip, mary: maryTrip, samuel: samuelTrip, joseph: josephTrip },
    steps,
  };
}
