import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ParcelsService } from './parcels.service';

const point = (id: string) => ({ id, name: id, latitude: -1, longitude: 37 });

describe('ParcelsService customer bookings', () => {
  const journey = { planPreview: jest.fn().mockResolvedValue({ legs: [{ routeId: 'r1' }], summary: 'Route (A → B)' }) };

  it('requires an authenticated customer profile with a phone number', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ name: 'Customer', email: 'customer@example.com', phone: null, isActive: true }) },
      transitPoint: { findFirst: jest.fn(({ where }) => Promise.resolve(point(where.id))) },
    };
    const service = new ParcelsService(prisma as never, {} as never, {} as never, journey as never);

    await expect(service.create({
      senderName: 'Spoofed', senderEmail: 'spoofed@example.com', senderPhone: '+254700000000',
      recipientName: 'Recipient', recipientEmail: 'recipient@example.com', recipientPhone: '0711111111',
      pickupTransitPointId: 'juja', destinationTransitPointId: 'thika', weight: 1,
    }, 'customer-id', 'CUSTOMER')).rejects.toThrow(BadRequestException);
  });

  it('rejects a booking without a destination station', async () => {
    const prisma = { transitPoint: { findFirst: jest.fn(({ where }) => Promise.resolve(where.id ? point(where.id) : null)) } };
    const service = new ParcelsService(prisma as never, {} as never, {} as never, journey as never);
    await expect(service.create({ recipientName: 'R', recipientEmail: 'r@example.com', recipientPhone: '0711111111', pickupTransitPointId: 'juja', weight: 1 } as never, 'customer-id', 'CUSTOMER'))
      .rejects.toThrow('Select the destination transit point');
  });

  it('locks route-critical fields once the origin station has confirmed receipt', async () => {
    const parcel = { id: 'p1', senderId: 'customer-id', status: 'at_origin_transit_point', originTransitPointId: 'juja', destinationTransitPointId: 'thika', weight: 1, deliveryMethod: 'STATION_COLLECTION' };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ email: 'customer@example.com' }) },
      parcel: { findFirst: jest.fn().mockResolvedValue({ ...parcel, sender: null, recipient: null, driver: null, statusHistory: [], reviews: [] }), findUniqueOrThrow: jest.fn().mockResolvedValue(parcel) },
    };
    const service = new ParcelsService(prisma as never, {} as never, {} as never, journey as never);
    await expect(service.update('p1', { destinationTransitPointId: 'nairobi' }, 'customer-id', 'CUSTOMER')).rejects.toThrow('locked');
    await expect(service.update('p1', { weight: 5 }, 'staff-id', 'ADMIN')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
