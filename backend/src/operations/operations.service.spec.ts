import { NotFoundException } from '@nestjs/common';
import { BatchStatus, UserRole } from '@prisma/client';
import { OperationsService } from './operations.service';

describe('OperationsService batch custody', () => {
  const batch = { id: 'batch-1', driverId: 'driver-a', routeId: 'route-1', status: BatchStatus.CREATED };

  const buildService = () => {
    const prisma = {
      batch: {
        findUnique: jest.fn().mockResolvedValue(batch),
        findFirst: jest.fn().mockResolvedValue(batch),
      },
    };
    return { prisma, service: new OperationsService(prisma as never, {} as never, { sendGenericEmail: jest.fn() } as never) };
  };

  it('hides a batch from a driver who does not own it', async () => {
    const { service } = buildService();
    await expect(service.getBatch(batch.id, { id: 'driver-b', role: UserRole.DRIVER })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('prevents another driver from confirming the physical load', async () => {
    const { service } = buildService();
    await expect(service.confirmBatchLoad(batch.id, ['parcel-1'], { id: 'driver-b', role: UserRole.DRIVER })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('prevents another driver from recording a movement event', async () => {
    const { service } = buildService();
    await expect(service.recordBatchEvent(batch.id, { type: 'DEPARTED' }, { id: 'driver-b', role: UserRole.DRIVER })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not mutate lockers when no collection codes have expired', async () => {
    const { service, prisma } = buildService();
    (prisma as any).collectionCode = { findMany: jest.fn().mockResolvedValue([]) };
    await expect(service.expireLockerAssignments(new Date('2026-01-01'))).resolves.toEqual({ expired: 0 });
  });
});
