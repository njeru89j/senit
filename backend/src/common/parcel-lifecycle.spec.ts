import { BadRequestException } from '@nestjs/common';
import { ParcelStatus } from '@prisma/client';
import { assertParcelTransition, canTransitionParcel } from './parcel-lifecycle';

describe('parcel lifecycle', () => {
  it.each([
    [ParcelStatus.assigned, ParcelStatus.collected],
    [ParcelStatus.collected, ParcelStatus.in_transit],
    [ParcelStatus.in_transit, ParcelStatus.arrived_at_transit_point],
    [ParcelStatus.arrived_at_transit_point, ParcelStatus.in_transit],
    [ParcelStatus.arrived_at_transit_point, ParcelStatus.at_transit_point],
    [ParcelStatus.at_transit_point, ParcelStatus.in_transit],
    [ParcelStatus.in_transit, ParcelStatus.at_destination],
    [ParcelStatus.at_destination, ParcelStatus.in_locker],
    [ParcelStatus.in_locker, ParcelStatus.completed],
  ])('allows %s -> %s', (current, next) => expect(canTransitionParcel(current, next)).toBe(true));

  it.each([
    [ParcelStatus.assigned, ParcelStatus.in_transit],
    [ParcelStatus.collected, ParcelStatus.completed],
    [ParcelStatus.completed, ParcelStatus.in_transit],
    [ParcelStatus.cancelled, ParcelStatus.assigned],
  ])('rejects %s -> %s', (current, next) => expect(() => assertParcelTransition(current, next)).toThrow(BadRequestException));
});
