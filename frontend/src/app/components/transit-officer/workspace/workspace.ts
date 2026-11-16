import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { Subscription, debounceTime, interval } from 'rxjs';
import { SidebarComponent } from '../../shared/sidebar/sidebar';
import { OperationsService, VerificationOutcome } from '../../../services/operations.service';
import { AuthService } from '../../../services/auth.service';
import { RealtimeService } from '../../../services/realtime.service';

type Tab = 'receive' | 'drivers' | 'arrivals' | 'transfers' | 'collection' | 'exceptions' | 'fleet';

/**
 * Transit officer workspace. Every queue comes from GET /operations/transit-officer/queues and every
 * action is validated on the server (station scoping, state, idempotency).
 */
@Component({ selector: 'app-transit-workspace', standalone: true, imports: [CommonModule, FormsModule, RouterModule, SidebarComponent], templateUrl: './workspace-dashboard.html', styleUrl: './workspace-dashboard.css' })
export class TransitWorkspace implements OnInit, OnDestroy {
  data: any = null;
  points: any[] = [];
  tab: Tab = 'receive';
  busy = false;
  message = '';
  messageKind: 'info' | 'error' = 'info';
  now = Date.now();
  /** Admins work any station: '' means every station, otherwise the chosen transit point. */
  isAdmin = false;
  stationId = '';
  receipt: { trackingNumber: string; sealIdentifier: string; qrDataUrl: string; parcel?: any; confirmedAt: Date } | null = null;
  verifySelections: Record<string, { selected: boolean; outcome: VerificationOutcome; notes: string }> = {};
  receiveReference = '';
  eligible: { leg: any; drivers: any[] } | null = null;
  resolving: { alert: any; outcome: string; action: 'CONTINUE' | 'CANCEL_PARCEL' | 'REPLAN' } | null = null;
  private subscriptions: Subscription[] = [];

  constructor(private api: OperationsService, private route: ActivatedRoute, private auth: AuthService, private realtime: RealtimeService) {}

  ngOnInit() {
    this.isAdmin = this.auth.getCurrentUser()?.role === 'ADMIN';
    const initial = this.route.snapshot.queryParamMap.get('tab') as Tab | null;
    if (initial) this.tab = initial;
    this.api.transitPoints().subscribe((points) => (this.points = points.filter((point) => point.active !== false)));
    this.load();
    this.realtime.connect();
    this.subscriptions.push(
      this.realtime.workflowUpdates$.pipe(debounceTime(500)).subscribe(() => this.load(false)),
      interval(1000).subscribe(() => (this.now = Date.now())),
      interval(60_000).subscribe(() => this.load(false)),
    );
  }

  ngOnDestroy() { this.subscriptions.forEach((subscription) => subscription.unsubscribe()); }

  get scope() { return this.isAdmin ? this.stationId || undefined : undefined; }
  get q() { return this.data?.queues ?? {}; }
  get counts() { return this.data?.counts ?? {}; }
  get stationTitle() {
    const stations = this.data?.stations ?? [];
    if (this.isAdmin && !this.stationId) return 'All transit points';
    return stations.map((station: any) => station.name).join(', ') || 'Transit Officer Dashboard';
  }
  /** The station an action happens at: the admin's chosen station, or the officer's (single) station. */
  get actingStationId(): string | null {
    if (this.isAdmin) return this.stationId || null;
    return this.data?.stations?.[0]?.id ?? null;
  }

  load(showBusy = true) {
    if (showBusy) this.busy = true;
    this.api.stationQueues(this.scope).subscribe({
      next: (data) => {
        this.data = data;
        this.busy = false;
        for (const group of data.queues?.toVerify ?? []) for (const parcel of group.parcels) {
          this.verifySelections[parcel.id] ??= { selected: false, outcome: 'VERIFIED', notes: '' };
        }
      },
      error: (error) => { this.busy = false; this.show(error?.error?.message ?? 'Could not load the station queues', 'error'); },
    });
  }

  changeStation() { this.data = null; this.verifySelections = {}; this.load(); }
  switchTab(tab: Tab) { this.tab = tab; this.message = ''; }
  private show(message: string, kind: 'info' | 'error' = 'info') { this.message = message; this.messageKind = kind; }

  private run(request: any, success: (result: any) => string) {
    if (this.busy) return;
    this.busy = true;
    this.message = '';
    request.subscribe({
      next: (result: any) => { this.busy = false; this.show(success(result)); this.load(false); },
      error: (error: any) => { this.busy = false; this.show(error?.error?.message ?? 'The action could not be completed', 'error'); this.load(false); },
    });
  }

  remaining(deadline: string | null): string {
    if (!deadline) return '';
    const ms = new Date(deadline).getTime() - this.now;
    if (ms <= 0) return 'expired';
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    return hours ? `${hours}h ${minutes}m` : `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`;
  }

  // Receive at origin
  confirmReceived(parcel: any) {
    this.run(this.api.confirmParcelReceived(parcel.id), (result) => {
      this.receipt = result.receipt ? { ...result.receipt, parcel: { ...parcel, ...result.parcel }, confirmedAt: new Date() } : null;
      return result.message;
    });
  }

  printReceipt() {
    if (!this.receipt) return;
    const receipt = this.receipt;
    const parcel = receipt.parcel ?? {};
    const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const safe = (value: unknown) => String(value ?? '—').replace(/[&<>"']/g, (char) => escapes[char] ?? char);
    const printWindow = window.open('', '_blank', 'width=820,height=900');
    if (!printWindow) { this.show('Please allow pop-ups to print the transit receipt.', 'error'); return; }
    printWindow.document.write(`<!doctype html><html><head><title>Receipt ${safe(receipt.trackingNumber)}</title><style>body{font-family:Arial,sans-serif;color:#172033;margin:32px}.receipt{max-width:720px;margin:auto;border:2px solid #dbbb02;border-radius:14px;padding:28px}.brand{display:flex;justify-content:space-between;border-bottom:1px solid #dce2ea;padding-bottom:18px}.brand h1{margin:0;color:#14213d}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:24px 0}.item{padding:12px;background:#f7f9fc;border-radius:8px}.item span{display:block;font-size:11px;font-weight:bold;text-transform:uppercase;color:#667085;margin-bottom:5px}.qr{text-align:center}.qr img{width:180px;height:180px}</style></head><body><section class="receipt"><header class="brand"><div><h1>SendIT</h1><p>Transit parcel receipt</p></div><div><b>RECEIVED</b><p>${safe(new Date(receipt.confirmedAt).toLocaleString())}</p></div></header><div class="grid"><div class="item"><span>Tracking number</span><b>${safe(receipt.trackingNumber)}</b></div><div class="item"><span>Security seal</span><b>${safe(receipt.sealIdentifier)}</b></div><div class="item"><span>Sender</span>${safe(parcel.senderName)}</div><div class="item"><span>Recipient</span>${safe(parcel.recipientName)}</div><div class="item"><span>From</span>${safe(parcel.origin ?? parcel.pickupAddress)}</div><div class="item"><span>To</span>${safe(parcel.destination ?? parcel.deliveryAddress)}</div><div class="item"><span>Weight</span>${safe(parcel.weight)} kg</div><div class="item"><span>Collection</span>${safe(parcel.deliveryMethod === 'SMART_LOCKER' ? 'Smart locker' : 'Station counter')}</div></div><div class="qr"><img src="${receipt.qrDataUrl}" alt="Receipt QR code"><p>Scan to verify the SendIT security seal.</p></div></section><script>window.onload=()=>window.print();<\/script></body></html>`);
    printWindow.document.close();
  }

  // Driver assignment exceptions
  retry(item: any) { this.run(this.api.retryLeg(item.legId), (result) => result.assigned ? `${item.trackingNumber} assigned to ${result.driver.name}.` : `${item.trackingNumber} is still waiting: ${result.reason}`); }
  cancelAssignment(item: any) {
    const reason = prompt(`Why are you cancelling ${item.assignment.driver?.name}'s assignment for ${item.trackingNumber}?`);
    if (!reason?.trim()) return;
    this.run(this.api.cancelAssignment(item.assignment.id, reason.trim()), (result) => result.message);
  }
  showEligible(item: any) {
    this.eligible = { leg: item, drivers: [] };
    this.api.eligibleDrivers(item.legId).subscribe({
      next: (drivers) => { if (this.eligible) this.eligible.drivers = drivers; },
      error: (error) => { this.eligible = null; this.show(error?.error?.message ?? 'Could not load drivers', 'error'); },
    });
  }
  assignManually(driver: any) {
    if (!this.eligible) return;
    const leg = this.eligible.leg;
    this.eligible = null;
    this.run(this.api.assignLeg(leg.legId, driver.tripId), () => `${leg.trackingNumber} offered to ${driver.driverName}; they have 3 hours to accept.`);
  }
  reasonLabel(reason: string | null): string {
    const labels: Record<string, string> = {
      ROUTE_INACTIVE: 'route inactive', WRONG_ROUTE_OR_DIRECTION: 'wrong route or direction', PICKUP_PASSED: 'already passed this station',
      INSUFFICIENT_CAPACITY: 'not enough capacity', DECLINED: 'declined this parcel on this trip', MOTORCYCLE_ROUTE_TOO_LONG: 'route too long for a motorcycle',
    };
    return reason ? labels[reason] ?? reason : '';
  }

  // Arrivals and verification
  trackingNumbers(group: any) { return group.parcels.map((parcel: any) => parcel.trackingNumber).join(', '); }
  groupKey(group: any) { return `${group.trip?.id ?? 'none'}|${group.transitPointId}`; }
  allSelected(group: any) { return group.parcels.every((parcel: any) => this.verifySelections[parcel.id]?.selected); }
  toggleAll(group: any, value: boolean) { for (const parcel of group.parcels) this.verifySelections[parcel.id].selected = value; }
  selectedIn(group: any) { return group.parcels.filter((parcel: any) => this.verifySelections[parcel.id]?.selected); }
  verifyGroup(group: any) {
    const items = this.selectedIn(group).map((parcel: any) => ({ parcelId: parcel.id, outcome: this.verifySelections[parcel.id].outcome, notes: this.verifySelections[parcel.id].notes || undefined }));
    if (!items.length) return;
    const flagged = items.filter((item: any) => item.outcome !== 'VERIFIED').length;
    if (flagged && !confirm(`${flagged} parcel(s) will be recorded as an exception. Continue?`)) return;
    this.run(this.api.verify(group.transitPointId, items), (result) => {
      for (const item of items) delete this.verifySelections[item.parcelId];
      return Object.entries(result.summary).map(([key, count]) => `${count} ${key.toLowerCase().replace('_', ' ')}`).join(', ') + '.';
    });
  }
  receiveByReference() {
    const stationId = this.actingStationId;
    if (!stationId) { this.show('Choose a transit point first.', 'error'); return; }
    const reference = this.receiveReference.trim();
    if (!reference) return;
    this.run(this.api.receiveByTracking(stationId, reference), (result) => { this.receiveReference = ''; return result.results?.[0]?.message ?? 'Recorded.'; });
  }

  // Collection
  handOver(parcel: any) {
    if (!confirm(`Hand ${parcel.trackingNumber} to ${parcel.recipientName}? Check the collector's ID first.`)) return;
    this.run(this.api.transitPickup(parcel.id), () => `${parcel.trackingNumber} handed over and delivered.`);
  }
  putInLocker(parcel: any) { this.run(this.api.assignLocker(parcel.id), (result) => result.message); }
  placed(parcel: any) { this.run(this.api.lockerPlaced(parcel.locker.lockerAssignmentId), (result) => result.message); }
  collectWithCode(parcel: any) {
    const code = prompt(`Enter the collection code for ${parcel.trackingNumber}`)?.trim();
    if (!code || !parcel.locker?.lockerAssignmentId) return;
    this.run(this.api.collectLocker(parcel.locker.lockerAssignmentId, code), () => `${parcel.trackingNumber} collected from the locker.`);
  }

  // Exceptions
  startResolve(alert: any, action: 'CONTINUE' | 'CANCEL_PARCEL' | 'REPLAN') { this.resolving = { alert, outcome: '', action }; }
  confirmResolve() {
    if (!this.resolving || this.resolving.outcome.trim().length < 5) return;
    const { alert, outcome, action } = this.resolving;
    this.resolving = null;
    this.run(this.api.resolveAlert(alert.id, { status: 'RESOLVED', outcome: outcome.trim(), action }), (result) => result?.status === 'RESOLVED'
      ? `Exception resolved for ${alert.parcel?.trackingNumber ?? 'the parcel'}.`
      : `${alert.parcel?.trackingNumber ?? 'The parcel'} still has no route; the exception stays open.`);
  }
  investigate(alert: any) { this.run(this.api.resolveAlert(alert.id, { status: 'UNDER_INVESTIGATION' }), () => 'Marked as under investigation.'); }
  /** Re-plan dialog; an admin may also change the destination. */
  replanning: { parcel: any; reason: string; destinationTransitPointId: string } | null = null;
  replan(parcel: any) { this.replanning = { parcel, reason: '', destinationTransitPointId: parcel.destinationTransitPointId ?? '' }; }
  confirmReplan() {
    if (!this.replanning || this.replanning.reason.trim().length < 5) return;
    const { parcel, reason, destinationTransitPointId } = this.replanning;
    const changed = this.isAdmin && destinationTransitPointId && destinationTransitPointId !== parcel.destinationTransitPointId;
    this.replanning = null;
    this.run(this.api.replan(parcel.id, reason.trim(), changed ? destinationTransitPointId : undefined), (result) => result?.message ?? `${parcel.trackingNumber}'s journey was re-planned from this station.`);
  }
  correctWeight(parcel: any) {
    const value = prompt(`Weighed weight for ${parcel.trackingNumber} in kg`, String(parcel.weight));
    if (!value) return;
    const reason = prompt('Reason for the correction');
    if (!reason?.trim()) return;
    this.run(this.api.correctWeight(parcel.id, Number(value), reason.trim()), () => `${parcel.trackingNumber} weight corrected; assignment re-evaluated.`);
  }
  cancelParcel(parcel: any) {
    const reason = prompt(`Why is ${parcel.trackingNumber} being cancelled?`);
    if (!reason?.trim()) return;
    this.run(this.api.cancelParcel(parcel.id, reason.trim()), () => `${parcel.trackingNumber} cancelled.`);
  }
  alertLabel(type: string) {
    const labels: Record<string, string> = {
      PARCEL_MISSING: 'Missing on hand-over', PARCEL_DAMAGED: 'Received damaged', UNEXPECTED_PARCEL: 'Unexpected parcel', ROUTE_UNAVAILABLE: 'Route unavailable',
      CUSTODY_EXCEPTION: 'Driver could not finish', COLLECTION_OVERDUE: 'Collection overdue', SEAL_BROKEN: 'Seal broken / tamper', SEAL_DAMAGED: 'Seal damaged', QR_MISMATCH: 'Seal QR mismatch',
    };
    return labels[type] ?? type.replaceAll('_', ' ').toLowerCase();
  }
}
