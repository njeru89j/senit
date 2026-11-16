import { ConflictException, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, TripStatus } from '@prisma/client';
import { TripsService } from './workflow/trips.service';
import { DispatchService } from './workflow/dispatch.service';

/** Ownership and state guards that must hold before any database write. */
describe('workflow guards', () => {
  const trip = { id: 'trip-1', driverId: 'driver-a', routeId: 'route-1', status: TripStatus.CREATED, currentTransitPointId: 'p1', atStop: true };
  const prisma: any = {
    trip: { findFirst: jest.fn(({ where }) => Promise.resolve(where.driverId === trip.driverId && where.id === trip.id ? trip : null)), findUnique: jest.fn().mockResolvedValue(trip) },
    parcelAssignment: { findFirst: jest.fn(({ where }) => Promise.resolve(where.driverId === 'driver-a' ? { id: 'as-1', driverId: 'driver-a', status: AssignmentStatus.COLLECTED, legId: 'leg-1', parcelId: 'p', trip, leg: null } : null)) },
    $transaction: jest.fn(),
  };
  const ctx: any = { prisma };
  const dispatch = new DispatchService(ctx);
  const trips = new TripsService(ctx, dispatch);

  it('hides a trip from a driver who does not own it', async () => {
    await expect(trips.startTrip('trip-1', 'driver-b')).rejects.toBeInstanceOf(NotFoundException);
    await expect(trips.depart('trip-1', 'driver-b')).rejects.toBeInstanceOf(NotFoundException);
    await expect(trips.complete('trip-1', 'driver-b')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not let another driver accept, reject or collect an assignment', async () => {
    await expect(dispatch.accept('as-1', 'driver-b')).rejects.toBeInstanceOf(NotFoundException);
    await expect(dispatch.reject('as-1', 'driver-b', 'not my parcel')).rejects.toBeInstanceOf(NotFoundException);
    await expect(trips.collect('as-1', 'driver-b')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to reject a parcel that is already collected', async () => {
    await expect(dispatch.reject('as-1', 'driver-a', 'changed my mind')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('only completes a trip at its route endpoint', async () => {
    await expect(trips.complete('trip-1', 'driver-a')).rejects.toBeInstanceOf(ConflictException);
  });
});
