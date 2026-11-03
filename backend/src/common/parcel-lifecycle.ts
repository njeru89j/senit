import { BadRequestException } from '@nestjs/common';
import { ParcelStatus } from '@prisma/client';

/**
 * Customer-facing parcel lifecycle. Driver assignment, journey legs, trips and custody are tracked on
 * their own records (ParcelAssignment, ParcelLeg, Trip, Parcel.custody) and never folded into this status.
 *
 *   awaiting_confirmation → at_origin_transit_point → collected → in_transit → arrived_at_transit_point
 *   → at_transit_point (transfer, next leg) | at_destination (ready) → locker_assigned → in_locker → delivered → completed
 *
 * Legacy values (created, pending, awaiting_driver_assignment, assigned, awaiting_pickup, picked_up,
 * batch_transferred, out_for_delivery, ready_for_locker_collection, collected_from_locker,
 * delivered_to_recipient, delivery_unsuccessful) are no longer written; existing rows were migrated.
 */
export const PARCEL_STATUS_TRANSITIONS: Readonly<Record<ParcelStatus, readonly ParcelStatus[]>> = {
  awaiting_confirmation: [ParcelStatus.at_origin_transit_point, ParcelStatus.cancelled],
  at_origin_transit_point: [ParcelStatus.collected, ParcelStatus.in_transit, ParcelStatus.at_transit_point, ParcelStatus.cancelled],
  collected: [ParcelStatus.in_transit, ParcelStatus.arrived_at_transit_point],
  in_transit: [ParcelStatus.arrived_at_transit_point],
  arrived_at_transit_point: [ParcelStatus.at_transit_point, ParcelStatus.at_origin_transit_point, ParcelStatus.at_destination, ParcelStatus.tampering_alert],
  at_transit_point: [ParcelStatus.collected, ParcelStatus.in_transit, ParcelStatus.at_destination, ParcelStatus.tampering_alert, ParcelStatus.cancelled],
  at_destination: [ParcelStatus.locker_assigned, ParcelStatus.delivered, ParcelStatus.at_transit_point, ParcelStatus.cancelled],
  locker_assigned: [ParcelStatus.in_locker, ParcelStatus.delivered, ParcelStatus.at_destination, ParcelStatus.cancelled],
  in_locker: [ParcelStatus.delivered, ParcelStatus.at_destination],
  delivered: [ParcelStatus.completed],
  completed: [],
  tampering_alert: [ParcelStatus.at_transit_point, ParcelStatus.at_origin_transit_point, ParcelStatus.at_destination, ParcelStatus.cancelled],
  cancelled: [],
  returned: [],
  // Legacy values: nothing moves into them any more.
  created: [], pending: [], awaiting_driver_assignment: [], assigned: [], awaiting_pickup: [], picked_up: [],
  batch_transferred: [], out_for_delivery: [], ready_for_locker_collection: [], collected_from_locker: [],
  delivered_to_recipient: [], delivery_unsuccessful: [],
};

/** Dashboard groupings shared by every counter so no status is dropped from totals. */
export const PARCEL_STATUS_GROUPS: Readonly<Record<'awaitingStart' | 'inTransit' | 'awaitingCollection' | 'finished' | 'closed', ParcelStatus[]>> = {
  /** Booked but not yet received at the origin station. */
  awaitingStart: [ParcelStatus.awaiting_confirmation, ParcelStatus.created, ParcelStatus.pending],
  /** In the network: at a station waiting for a driver, with a driver, or held for review. */
  inTransit: [
    ParcelStatus.at_origin_transit_point, ParcelStatus.collected, ParcelStatus.in_transit, ParcelStatus.arrived_at_transit_point,
    ParcelStatus.at_transit_point, ParcelStatus.tampering_alert,
    ParcelStatus.awaiting_driver_assignment, ParcelStatus.assigned, ParcelStatus.awaiting_pickup, ParcelStatus.picked_up, ParcelStatus.batch_transferred,
  ],
  /** At the final destination station or locker, waiting for the recipient. */
  awaitingCollection: [ParcelStatus.at_destination, ParcelStatus.locker_assigned, ParcelStatus.in_locker, ParcelStatus.ready_for_locker_collection, ParcelStatus.out_for_delivery, ParcelStatus.delivery_unsuccessful],
  finished: [ParcelStatus.delivered, ParcelStatus.completed, ParcelStatus.collected_from_locker, ParcelStatus.delivered_to_recipient],
  closed: [ParcelStatus.cancelled, ParcelStatus.returned],
};

export function canTransitionParcel(current: ParcelStatus, next: ParcelStatus): boolean {
  return PARCEL_STATUS_TRANSITIONS[current].includes(next);
}

export function assertParcelTransition(current: ParcelStatus, next: ParcelStatus): void {
  if (!canTransitionParcel(current, next)) throw new BadRequestException(`Parcel cannot move from ${current} to ${next}`);
}
