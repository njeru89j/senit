import { BadRequestException } from '@nestjs/common';
import { ParcelStatus } from '@prisma/client';
import { assertParcelTransition, canTransitionParcel, PARCEL_STATUS_GROUPS } from './parcel-lifecycle';

describe('parcel lifecycle', () => {
  it.each([
    [ParcelStatus.awaiting_confirmation, ParcelStatus.at_origin_transit_point],
    [ParcelStatus.at_origin_transit_point, ParcelStatus.collected],
    [ParcelStatus.collected, ParcelStatus.in_transit],
    [ParcelStatus.in_transit, ParcelStatus.arrived_at_transit_point],
    [ParcelStatus.arrived_at_transit_point, ParcelStatus.at_transit_point],
    [ParcelStatus.arrived_at_transit_point, ParcelStatus.at_destination],
    [ParcelStatus.at_transit_point, ParcelStatus.in_transit],
    [ParcelStatus.at_destination, ParcelStatus.locker_assigned],
    [ParcelStatus.locker_assigned, ParcelStatus.in_locker],
    [ParcelStatus.in_locker, ParcelStatus.delivered],
    [ParcelStatus.at_destination, ParcelStatus.delivered],
    [ParcelStatus.delivered, ParcelStatus.completed],
  ])('allows %s -> %s', (current, next) => expect(canTransitionParcel(current, next)).toBe(true));

  it.each([
    [ParcelStatus.awaiting_confirmation, ParcelStatus.in_transit],
    [ParcelStatus.in_transit, ParcelStatus.delivered],
    [ParcelStatus.in_transit, ParcelStatus.cancelled],
    [ParcelStatus.collected, ParcelStatus.cancelled],
    [ParcelStatus.completed, ParcelStatus.in_transit],
    [ParcelStatus.cancelled, ParcelStatus.at_origin_transit_point],
    [ParcelStatus.at_origin_transit_point, ParcelStatus.assigned],
  ])('rejects %s -> %s', (current, next) => expect(() => assertParcelTransition(current, next)).toThrow(BadRequestException));

  it('counts every status in exactly one dashboard group', () => {
    const grouped = Object.values(PARCEL_STATUS_GROUPS).flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(Object.values(ParcelStatus).sort());
  });
});
