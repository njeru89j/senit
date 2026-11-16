import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { Subscription, debounceTime, interval } from 'rxjs';
import { SidebarComponent } from '../../shared/sidebar/sidebar';
import { ToastService } from '../../shared/toast/toast.service';
import { OperationsService } from '../../../services/operations.service';
import { RealtimeService } from '../../../services/realtime.service';

/**
 * The driver's trip workspace. Everything shown is derived by the server (GET /operations/driver/workspace):
 * offers and their 3-hour acceptance deadlines, capacity, the trip's stops with the pickup/drop-off work at each,
 * and which actions are currently allowed. Buttons only request actions; the server enforces every rule.
 */
@Component({
  selector: 'app-assigned-parcels',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent],
  templateUrl: './assigned-parcels.html',
  styleUrls: ['./assigned-parcels.css'],
})
export class AssignedParcels implements OnInit, OnDestroy {
  userRole = 'DRIVER';
  workspace: any = null;
  loading = true;
  busy = false;
  error: string | null = null;
  now = Date.now();
  selectedRouteId = '';
  rejecting: any = null;
  rejectionReason = '';
  private subscriptions: Subscription[] = [];

  constructor(
    private api: OperationsService,
    private toast: ToastService,
    private realtime: RealtimeService,
    private router: Router,
  ) {}

  ngOnInit() {
    this.load();
    this.realtime.connect();
    this.subscriptions.push(
      this.realtime.workflowUpdates$.pipe(debounceTime(400)).subscribe(() => this.load(false)),
      interval(1000).subscribe(() => (this.now = Date.now())),
      // Deadlines are enforced by the server; a periodic refresh keeps an idle screen truthful.
      interval(60_000).subscribe(() => this.load(false)),
    );
  }

  ngOnDestroy() {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
  }

  load(showSpinner = true) {
    if (showSpinner) this.loading = true;
    this.api.driverWorkspace().subscribe({
      next: (workspace) => {
        this.workspace = workspace;
        this.loading = false;
        this.error = null;
        if (!this.selectedRouteId && workspace.routes?.length) this.selectedRouteId = workspace.routes[0].id;
      },
      error: (error) => { this.loading = false; this.error = this.message(error, 'Could not load your trip'); },
    });
  }

  private message(error: any, fallback: string): string {
    return error?.error?.message ?? error?.message ?? fallback;
  }

  /** Runs one server action, then shows the fresh workspace it returns (or reloads). */
  private act(request: any, success: string) {
    if (this.busy) return;
    this.busy = true;
    request.subscribe({
      next: (result: any) => {
        this.busy = false;
        if (result?.driver && result?.capacity) this.workspace = result; else this.load(false);
        this.toast.showSuccess(success);
      },
      error: (error: any) => { this.busy = false; this.toast.showError(this.message(error, 'That action could not be completed')); this.load(false); },
    });
  }

  get trip() { return this.workspace?.trip ?? null; }
  get selectedRoute() { return this.workspace?.routes?.find((route: any) => route.id === this.selectedRouteId); }
  get capacityPercent() {
    const capacity = this.workspace?.capacity;
    return capacity?.capacityKg ? Math.min(100, ((capacity.loadedKg + capacity.reservedKg) / capacity.capacityKg) * 100) : 0;
  }
  get loadedPercent() {
    const capacity = this.workspace?.capacity;
    return capacity?.capacityKg ? Math.min(100, (capacity.loadedKg / capacity.capacityKg) * 100) : 0;
  }
  get currentStop() { return this.trip?.stops?.find((stop: any) => stop.state === 'CURRENT') ?? null; }

  /** Stops the vehicle may record arriving at next: inactive stops up to and including the next active one. */
  canArriveAt(stop: any): boolean {
    if (this.trip?.status !== 'IN_TRANSIT' || stop.state !== 'UPCOMING') return false;
    const upcoming = this.trip.stops.filter((item: any) => item.state === 'UPCOMING');
    const nextActive = upcoming.find((item: any) => item.active);
    return !nextActive || stop.index <= nextActive.index;
  }

  remaining(deadline: string | Date | null): string {
    if (!deadline) return '';
    const ms = new Date(deadline).getTime() - this.now;
    if (ms <= 0) return 'expired';
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }

  urgent(deadline: string | Date | null): boolean {
    return !!deadline && new Date(deadline).getTime() - this.now < 30 * 60_000;
  }

  openTrip(route: any, endpoint: { id: string; name: string }) {
    this.act(this.api.openTrip(route.id, endpoint.id), `Trip opened from ${endpoint.name}. Parcels on your route will be offered to you.`);
  }

  accept(card: any) { this.act(this.api.acceptAssignment(card.assignmentId), `${card.trackingNumber} accepted. Collect it at ${card.from}.`); }
  openReject(card: any) { this.rejecting = card; this.rejectionReason = ''; }
  closeReject() { if (!this.busy) this.rejecting = null; }
  confirmReject() {
    if (!this.rejecting || this.rejectionReason.trim().length < 5) return;
    const card = this.rejecting;
    this.rejecting = null;
    this.act(this.api.rejectAssignment(card.assignmentId, this.rejectionReason.trim()), `${card.trackingNumber} declined; it will be offered to another driver.`);
  }

  canCollect(card: any): boolean {
    return card.status === 'ACCEPTED' && !!this.trip && this.trip.atStop && this.trip.currentTransitPointId === card.fromTransitPointId;
  }
  collect(card: any) { this.act(this.api.collectAssignment(card.assignmentId), `${card.trackingNumber} collected and loaded.`); }

  /** Uncollected accepted parcels at the start station are released when the vehicle leaves. */
  get uncollectedAtStart(): any[] {
    if (!this.trip || this.trip.status !== 'CREATED') return [];
    const start = this.trip.stops.find((stop: any) => stop.isStart);
    return (start?.pickups ?? []).filter((card: any) => card.status === 'ASSIGNED' || card.status === 'ACCEPTED');
  }
  startDelivery() {
    const left = this.uncollectedAtStart.length;
    if (left && !confirm(`${left} parcel(s) at ${this.trip.start} are not collected. Starting now releases them to other drivers. Start delivery?`)) return;
    this.act(this.api.startTrip(this.trip.id), 'Delivery started. Follow the route below.');
  }

  arrive(stop: any) { this.act(this.api.arrive(this.trip.id, stop.transitPointId), `Arrived at ${stop.name}.`); }
  depart() { this.act(this.api.depart(this.trip.id), `Departed ${this.currentStop?.name ?? 'the station'}.`); }
  dropAll() { this.act(this.api.drop(this.trip.id), 'Parcels handed over; the station will verify them.'); }
  dropOne(card: any) { this.act(this.api.drop(this.trip.id, [card.assignmentId]), `${card.trackingNumber} handed over.`); }
  returnOne(card: any) {
    if (!confirm(`Hand ${card.trackingNumber} back to ${card.from}? The station will verify it and find another driver.`)) return;
    this.act(this.api.returnParcels(this.trip.id, [card.assignmentId]), `${card.trackingNumber} handed back to the station.`);
  }
  completeTrip() {
    const due = this.currentStop?.drops?.filter((card: any) => card.status === 'COLLECTED').length ?? 0;
    if (!confirm(`Complete the trip at ${this.trip.end}?${due ? ` ${due} parcel(s) will be handed over here.` : ''}`)) return;
    this.act(this.api.completeTrip(this.trip.id), 'Trip completed.');
  }
  cancelTrip() {
    const reason = prompt('Why are you cancelling this trip?');
    if (!reason?.trim()) return;
    this.act(this.api.cancelTrip(this.trip.id, reason.trim()), 'Trip cancelled; your offers were released to other drivers.');
  }

  undroppedHere(): any[] { return (this.currentStop?.drops ?? []).filter((card: any) => card.status === 'COLLECTED'); }
  pickupsHere(): any[] { return (this.currentStop?.pickups ?? []).filter((card: any) => card.status !== 'COLLECTED' && card.status !== 'DROPPED' && card.status !== 'COMPLETED'); }
  collectedHere(): any[] { return (this.currentStop?.pickups ?? []).filter((card: any) => card.status === 'COLLECTED'); }

  operationLabel(stop: any): string {
    if (!stop.active) return 'No activity';
    const parts: string[] = [];
    if (stop.pickupCount) parts.push(`Pick up ${stop.pickupCount}`);
    if (stop.dropoffCount) parts.push(`Drop off ${stop.dropoffCount}`);
    if (stop.isEnd) parts.push('Route endpoint');
    return parts.join(' · ');
  }

  verificationLabel(value: string | null): string {
    return value === 'VERIFIED' ? 'verified by station' : value === 'MISSING' ? 'reported missing' : value === 'DAMAGED' ? 'received damaged' : value === 'TAMPER_ALERT' ? 'tamper alert' : '';
  }

  viewParcel(card: any) { this.router.navigate(['/driver/parcel-details', card.parcelId]); }
}
