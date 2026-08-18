import { BadRequestException } from '@nestjs/common';
import { ParcelsService } from './parcels.service';

describe('ParcelsService customer creation', () => {
  it('requires an authenticated customer profile with a phone number', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({
        name: 'Customer', email: 'customer@example.com', phone: null, isActive: true,
      }) },
    };
    const service = new ParcelsService(prisma as never, {} as never, {} as never);

    await expect(service.create({
      senderName: 'Spoofed', senderEmail: 'spoofed@example.com', senderPhone: '+254700000000',
      recipientName: 'Recipient', recipientEmail: 'recipient@example.com',
      recipientPhone: '+254711111111', pickupAddress: 'Juja Town Centre',
      deliveryAddress: 'Thika Town Centre', weight: 1,
    }, 'customer-id', 'CUSTOMER')).rejects.toThrow(BadRequestException);
  });
});
