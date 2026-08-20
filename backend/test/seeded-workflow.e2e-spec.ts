import { ParcelStatus, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

describe('seeded reroute-to-locker workflow (e2e)', () => {
  const prisma = new PrismaClient();
  afterAll(() => prisma.$disconnect());

  it('contains the ordered onward route and final locker custody', async () => {
    const route = await prisma.route.findUniqueOrThrow({ where: { name: 'Nairobi-Meru' } });
    const ordered = await prisma.routeTransitPoint.findMany({ where: { routeId: route.id }, orderBy: { sequence: 'asc' } });
    const points = await prisma.transitPoint.findMany({ where: { id: { in: ordered.map(item => item.transitPointId) } } });
    expect(ordered.map(item => points.find(point => point.id === item.transitPointId)?.name)).toEqual(['Thika Transit Hub', 'Chuka Transit Hub', 'Meru Destination Hub']);

    const parcel = await prisma.parcel.findUniqueOrThrow({ where: { trackingNumber: 'SENDIT-DEMO-REROUTE-001' } });
    expect(parcel.status).toBe(ParcelStatus.in_locker);
    expect(parcel.routeId).toBe(route.id);
    const assignment = await prisma.lockerAssignment.findFirstOrThrow({ where: { parcelId: parcel.id, collectedAt: null, cancelledAt: null } });
    const code = await prisma.collectionCode.findFirstOrThrow({ where: { lockerAssignmentId: assignment.id, usedAt: null } });
    expect(await bcrypt.compare('246810', code.codeHash)).toBe(true);
  });

  it('records transfer, ordered movement, destination verification, and locker placement', async () => {
    const parcel = await prisma.parcel.findUniqueOrThrow({ where: { trackingNumber: 'SENDIT-DEMO-REROUTE-001' } });
    const history = await prisma.parcelStatusHistory.findMany({ where: { parcelId: parcel.id }, orderBy: { timestamp: 'asc' } });
    expect(history.map(item => item.status)).toEqual(expect.arrayContaining([ParcelStatus.at_transit_point, ParcelStatus.in_transit, ParcelStatus.arrived_at_transit_point, ParcelStatus.at_destination, ParcelStatus.in_locker]));
    expect(await prisma.batch.count({ where: { OR: [{ batchNumber: 'DEMO-KISII-NBO-001' }, { batchNumber: 'DEMO-NBO-MERU-001' }] } })).toBe(2);
  });
});
