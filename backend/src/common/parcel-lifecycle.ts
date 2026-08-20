import { BadRequestException } from '@nestjs/common';
import { ParcelStatus } from '@prisma/client';

export const PARCEL_STATUS_TRANSITIONS: Readonly<Record<ParcelStatus, readonly ParcelStatus[]>> = {
  created: [ParcelStatus.awaiting_confirmation, ParcelStatus.awaiting_driver_assignment, ParcelStatus.pending, ParcelStatus.assigned, ParcelStatus.cancelled],
  awaiting_confirmation: [ParcelStatus.awaiting_driver_assignment, ParcelStatus.pending, ParcelStatus.cancelled],
  awaiting_driver_assignment: [ParcelStatus.assigned, ParcelStatus.cancelled],
  pending: [ParcelStatus.assigned, ParcelStatus.cancelled],
  assigned: [ParcelStatus.collected, ParcelStatus.cancelled],
  awaiting_pickup: [ParcelStatus.collected, ParcelStatus.cancelled],
  picked_up: [ParcelStatus.in_transit, ParcelStatus.cancelled],
  collected: [ParcelStatus.in_transit, ParcelStatus.cancelled],
  at_origin_transit_point: [ParcelStatus.in_transit, ParcelStatus.cancelled],
  in_transit: [ParcelStatus.arrived_at_transit_point, ParcelStatus.at_destination, ParcelStatus.delivery_unsuccessful, ParcelStatus.cancelled],
  arrived_at_transit_point: [ParcelStatus.in_transit, ParcelStatus.at_transit_point, ParcelStatus.at_destination, ParcelStatus.cancelled],
  at_transit_point: [ParcelStatus.in_transit, ParcelStatus.batch_transferred, ParcelStatus.cancelled],
  batch_transferred: [ParcelStatus.in_transit, ParcelStatus.cancelled],
  at_destination: [ParcelStatus.out_for_delivery, ParcelStatus.locker_assigned, ParcelStatus.in_locker, ParcelStatus.delivered_to_recipient, ParcelStatus.delivered, ParcelStatus.completed, ParcelStatus.cancelled],
  out_for_delivery: [ParcelStatus.delivered_to_recipient, ParcelStatus.delivery_unsuccessful, ParcelStatus.locker_assigned, ParcelStatus.cancelled],
  locker_assigned: [ParcelStatus.ready_for_locker_collection, ParcelStatus.in_locker, ParcelStatus.cancelled],
  ready_for_locker_collection: [ParcelStatus.in_locker, ParcelStatus.collected_from_locker, ParcelStatus.cancelled],
  in_locker: [ParcelStatus.collected_from_locker, ParcelStatus.completed, ParcelStatus.cancelled],
  collected_from_locker: [ParcelStatus.delivered, ParcelStatus.completed],
  delivered_to_recipient: [ParcelStatus.delivered, ParcelStatus.completed, ParcelStatus.cancelled],
  delivered: [ParcelStatus.completed],
  delivery_unsuccessful: [ParcelStatus.out_for_delivery, ParcelStatus.returned, ParcelStatus.cancelled],
  returned: [],
  tampering_alert: [ParcelStatus.in_transit, ParcelStatus.at_transit_point, ParcelStatus.returned, ParcelStatus.cancelled],
  completed: [],
  cancelled: [],
};

export function canTransitionParcel(current: ParcelStatus, next: ParcelStatus): boolean {
  return PARCEL_STATUS_TRANSITIONS[current].includes(next);
}

export function assertParcelTransition(current: ParcelStatus, next: ParcelStatus): void {
  if (!canTransitionParcel(current, next)) throw new BadRequestException(`Parcel cannot move from ${current} to ${next}`);
}
