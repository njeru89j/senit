/**
 * Parcel status groups shared by dashboard counters. Mirrors PARCEL_STATUS_GROUPS in
 * backend/src/common/parcel-lifecycle.ts so every status (including legacy rows) is counted once.
 */
export const PARCEL_STATUS_GROUPS = {
  awaitingStart: ['awaiting_confirmation', 'created', 'pending'],
  inTransit: [
    'at_origin_transit_point', 'collected', 'in_transit', 'arrived_at_transit_point', 'at_transit_point', 'tampering_alert',
    'awaiting_driver_assignment', 'assigned', 'awaiting_pickup', 'picked_up', 'batch_transferred',
  ],
  awaitingCollection: ['at_destination', 'locker_assigned', 'in_locker', 'ready_for_locker_collection', 'out_for_delivery', 'delivery_unsuccessful'],
  finished: ['delivered', 'completed', 'collected_from_locker', 'delivered_to_recipient'],
  closed: ['cancelled', 'returned'],
} as const;

export type ParcelStatusGroup = keyof typeof PARCEL_STATUS_GROUPS;

export function inStatusGroup(status: string | undefined, group: ParcelStatusGroup): boolean {
  return (PARCEL_STATUS_GROUPS[group] as readonly string[]).includes(status ?? '');
}

/** Customer-language labels; internal workflow terms never reach the screen. */
const LABELS: Record<string, string> = {
  awaiting_confirmation: 'Awaiting drop-off',
  at_origin_transit_point: 'At origin station',
  collected: 'Collected by driver',
  in_transit: 'In transit',
  arrived_at_transit_point: 'Arrived at station',
  at_transit_point: 'At transfer station',
  at_destination: 'Ready for collection',
  locker_assigned: 'Being placed in locker',
  in_locker: 'In smart locker',
  delivered: 'Delivered',
  completed: 'Delivered',
  tampering_alert: 'Delayed – under review',
  cancelled: 'Cancelled',
  returned: 'Returned',
};

export function parcelStatusLabel(status?: string): string {
  if (!status) return 'Unknown';
  return LABELS[status] ?? status.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Status options for filters, in lifecycle order. */
export const PARCEL_STATUS_FILTERS = [
  'awaiting_confirmation', 'at_origin_transit_point', 'collected', 'in_transit', 'arrived_at_transit_point', 'at_transit_point',
  'at_destination', 'locker_assigned', 'in_locker', 'delivered', 'completed', 'tampering_alert', 'cancelled',
].map((value) => ({ value, label: parcelStatusLabel(value) }));

/** CSS class by lifecycle stage, for statuses a screen does not style individually. */
export function parcelStatusClass(status?: string): string {
  if (inStatusGroup(status, 'awaitingStart')) return 'status-pending';
  if (inStatusGroup(status, 'inTransit')) return 'status-transit';
  if (inStatusGroup(status, 'awaitingCollection')) return 'status-delivered';
  if (inStatusGroup(status, 'finished')) return 'status-completed';
  if (inStatusGroup(status, 'closed')) return 'status-cancelled';
  return '';
}
