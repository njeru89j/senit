import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { AdminService } from '../../../services/admin.service';
import { OperationsService } from '../../../services/operations.service';
import { SidebarComponent } from '../../shared/sidebar/sidebar';
import { NetworkMapComponent } from '../../shared/network-map/network-map';
import { AuthService } from '../../../services/auth.service';
import { RealtimeService } from '../../../services/realtime.service';

type OperationsTab = 'network' | 'map' | 'trips' | 'lockers' | 'planning';
const TABS: OperationsTab[] = ['network', 'map', 'trips', 'lockers', 'planning'];

@Component({ selector: 'app-operations', standalone: true, imports: [CommonModule, FormsModule, SidebarComponent, NetworkMapComponent], templateUrl: './operations.html', styleUrls: ['./operations.css', './route-order.css'] })
export class Operations implements OnInit, OnDestroy {
  activeTab: OperationsTab = 'network';
  routes: any[] = []; points: any[] = []; report: any; lockers: any[] = []; trips: any[] = []; alerts: any[] = [];
  forecasts: any[] = []; recommendations: any[] = []; lockerExtensionRequests: any[] = [];
  route = { name: '', transitPointIds: [] as string[], distancesKm: [] as (number | null)[] };
  point = { name: '', routeId: '', latitude: null as number | null, longitude: null as number | null };
  stationForm = { transitPointId: '', name: '', address: '', latitude: 0, longitude: 0, openingHours: '' };
  compartmentForm = { stationId: '', compartmentNo: '', size: 'MEDIUM' };
  tripStatus = '';
  officerCandidates: any[] = []; nomineeId = ''; nomineeSearch = ''; nomineeResults: any[] = [];
  showNomineeSuggestions = false; selectedNomineeIndex = -1; busy = false; message = ''; generatedLockerCode: any = null;
  readonly isTransitOfficer: boolean;
  private nomineeSearch$ = new Subject<string>(); private nomineeSearchSubscription?: Subscription; private workflowSubscription?: Subscription;

  constructor(private api: OperationsService, private admin: AdminService, private activatedRoute: ActivatedRoute, auth: AuthService, private realtime: RealtimeService) {
    this.isTransitOfficer = auth.getCurrentUser()?.role === 'TRANSIT_OFFICER';
  }

  ngOnInit() {
    if (this.isTransitOfficer) this.activeTab = 'trips';
    const pick = (value: string | null | undefined) => {
      // Older links used "batches" for what is now trips.
      const tab = (value === 'batches' ? 'trips' : value) as OperationsTab;
      if (TABS.includes(tab) && !(this.isTransitOfficer && ['network', 'map', 'planning'].includes(tab))) this.activeTab = tab;
    };
    pick(this.activatedRoute.snapshot.data['initialTab']);
    this.activatedRoute.queryParamMap.subscribe((params) => pick(params.get('tab')));
    this.nomineeSearchSubscription = this.nomineeSearch$.pipe(debounceTime(300), distinctUntilChanged()).subscribe(() => this.searchNomineeSuggestions());
    this.refresh();
    // Re-plans, exceptions and trip changes made elsewhere update the live lists here.
    this.realtime.connect();
    this.workflowSubscription = this.realtime.workflowUpdates$.pipe(debounceTime(800)).subscribe(() => {
      if (this.busy) return;
      this.api.alerts().subscribe((v) => (this.alerts = v));
      this.loadTrips();
    });
  }

  refresh() {
    this.api.routes().subscribe((v) => (this.routes = v));
    this.api.transitPoints().subscribe((v) => (this.points = v));
    this.api.lockerStations().subscribe((v) => (this.lockers = v));
    this.api.lockerExtensionRequests().subscribe((v) => (this.lockerExtensionRequests = v));
    this.api.alerts().subscribe((v) => (this.alerts = v));
    this.loadTrips();
    if (this.isTransitOfficer) return;
    this.api.report().subscribe((v) => (this.report = v));
    this.api.forecasts().subscribe((v) => (this.forecasts = v));
    this.api.recommendations().subscribe((v) => (this.recommendations = v));
    this.api.transitOfficerCandidates().subscribe({ next: (v) => { this.officerCandidates = v; this.searchNomineeSuggestions(); }, error: () => this.loadNomineeFallback() });
  }

  loadTrips() { this.api.trips(this.tripStatus || undefined).subscribe((v) => (this.trips = v)); }
  switchTab(tab: OperationsTab) { this.activeTab = tab; this.message = ''; }

  get activePoints() { return this.points.filter((point) => point.active !== false); }
  get mappablePoints() { return this.points.filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && !(point.latitude === 0 && point.longitude === 0)); }
  get openAlerts() { return this.alerts.filter((alert) => alert.status !== 'RESOLVED'); }
  get nominatedTransitOfficers() { return this.officerCandidates.filter((user) => user.role === 'TRANSIT_OFFICER'); }
  get totalLockers() { return this.lockers.reduce((sum, station) => sum + (station.compartments?.length ?? 0), 0); }
  get lockerAssignments() {
    return this.lockers.flatMap((station) => (station.compartments ?? []).filter((compartment: any) => !!compartment.assignment)
      .map((compartment: any) => ({ ...compartment.assignment, stationName: station.name, compartmentNo: compartment.compartmentNo, size: compartment.size })));
  }

  pointName(id: string) { return this.points.find((point) => point.id === id)?.name ?? id; }
  routeNames(point: any) { return (point.routes ?? []).map((route: any) => route.name).join(', ') || '—'; }


  run(action: () => any, success: string) {
    this.busy = true; this.message = '';
    action().subscribe({ next: () => { this.busy = false; this.message = success; this.refresh(); }, error: (e: any) => { this.busy = false; this.message = e.error?.message ?? 'Operation failed'; } });
  }

  // Network
  addRouteStop(id: string) {
    if (!id || this.route.transitPointIds.includes(id)) return;
    this.route.transitPointIds.push(id);
    this.route.distancesKm.push(null);
  }
  removeRouteStop(index: number) { this.route.transitPointIds.splice(index, 1); this.route.distancesKm.splice(index, 1); }
  addRoute() {
    const data = { name: this.route.name.trim(), transitPointIds: [...this.route.transitPointIds], distancesKm: this.route.distancesKm.map((value) => (value === null || value === undefined || (value as any) === '' ? null : Number(value))) };
    this.busy = true; this.message = '';
    this.api.createRoute(data).subscribe({
      next: () => { this.busy = false; this.message = `Route ${data.name} created; it runs in both directions.`; this.route = { name: '', transitPointIds: [], distancesKm: [] }; this.refresh(); },
      error: (e: any) => { this.busy = false; this.message = e.error?.message ?? 'Could not create the route'; },
    });
  }
  addPoint() {
    const data = { name: this.point.name.trim(), latitude: Number(this.point.latitude), longitude: Number(this.point.longitude), routeId: this.point.routeId || undefined };
    this.busy = true; this.message = '';
    this.api.createTransitPoint(data).subscribe({
      next: () => { this.busy = false; this.message = `Transit point ${data.name} created.`; this.point = { name: '', routeId: '', latitude: null, longitude: null }; this.refresh(); },
      error: (e: any) => { this.busy = false; this.message = e.error?.message ?? 'Could not create the transit point'; },
    });
  }
  toggleRoute(route: any) {
    if (route.active && !confirm(`Deactivate ${route.name}? Journeys that have not started are re-planned; journeys already on the way are flagged for the stations.`)) return;
    this.run(() => this.api.updateRoute(route.id, { active: !route.active }), `Route ${route.active ? 'deactivated' : 'activated'}`);
  }
  togglePoint(point: any) { this.run(() => this.api.updateTransitPoint(point.id, { active: !point.active }), `Transit point ${point.active ? 'deactivated' : 'activated'}`); }
  moveRoutePoint(route: any, index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= route.transitPoints.length) return;
    [route.transitPoints[index], route.transitPoints[target]] = [route.transitPoints[target], route.transitPoints[index]];
    route.orderDirty = true;
  }
  saveRouteOrder(route: any) {
    const stops = route.transitPoints ?? [];
    const transitPointIds = stops.map((entry: any) => entry.transitPointId);
    const distancesKm = stops.map((entry: any, index: number) => (index === 0 || entry.distanceFromPreviousKm === null || entry.distanceFromPreviousKm === undefined || entry.distanceFromPreviousKm === '' ? null : Number(entry.distanceFromPreviousKm)));
    this.run(() => this.api.updateRoute(route.id, { transitPointIds, distancesKm }), `Stops saved for ${route.name}`);
    route.orderDirty = false;
  }

  // Trips and exceptions
  tripStatusLabel(status: string) { return status === 'CREATED' ? 'Preparing' : status === 'IN_TRANSIT' ? 'On the road' : status === 'CLOSED' ? 'Completed' : status === 'CANCELLED' ? 'Cancelled' : status; }
  tripParcelSummary(trip: any) {
    const p = trip.parcels ?? {};
    const parts = [p.COLLECTED ? `${p.COLLECTED} on board` : '', (p.ASSIGNED || 0) + (p.ACCEPTED || 0) ? `${(p.ASSIGNED || 0) + (p.ACCEPTED || 0)} to collect` : '', (p.DROPPED || 0) + (p.COMPLETED || 0) ? `${(p.DROPPED || 0) + (p.COMPLETED || 0)} handed over` : ''].filter(Boolean);
    return parts.join(' · ') || '—';
  }
  custodyException(trip: any) {
    const reason = prompt(`${trip.driver?.name} cannot continue trip ${trip.tripNumber}. What happened?`);
    if (!reason?.trim()) return;
    this.run(() => this.api.custodyException(trip.id, reason.trim()), 'Trip stopped. Uncollected parcels were reassigned; parcels on board stay with the driver until a station receives them.');
  }
  alertLabel(type: string) {
    const labels: Record<string, string> = {
      PARCEL_MISSING: 'Missing', PARCEL_DAMAGED: 'Damaged', UNEXPECTED_PARCEL: 'Unexpected', ROUTE_UNAVAILABLE: 'Route unavailable',
      CUSTODY_EXCEPTION: 'Driver could not finish', COLLECTION_OVERDUE: 'Collection overdue', SEAL_BROKEN: 'Tamper / seal broken', SEAL_DAMAGED: 'Seal damaged', QR_MISMATCH: 'Seal QR mismatch',
    };
    return labels[type] ?? type.replaceAll('_', ' ').toLowerCase();
  }
  resolveAlert(alert: any, action: 'CONTINUE' | 'CANCEL_PARCEL' | 'REPLAN') {
    const outcome = prompt(action === 'CANCEL_PARCEL' ? 'Why is the parcel being cancelled?' : 'What was found and done?');
    if (!outcome?.trim()) return;
    this.run(() => this.api.resolveAlert(alert.id, { status: 'RESOLVED', outcome: outcome.trim(), action }), action === 'REPLAN' ? 'Journey re-planned and exception resolved.' : 'Exception resolved.');
  }

  // Lockers
  lockerStatusLabel(status: string) { return status === 'AVAILABLE' ? 'Available' : status === 'RESERVED' ? 'Reserved' : status === 'AWAITING_COLLECTION' ? 'In use' : status === 'OUT_OF_SERVICE' ? 'Out of service' : status; }
  prefillStation() {
    const point = this.points.find((item) => item.id === this.stationForm.transitPointId);
    if (!point) return;
    this.stationForm = { ...this.stationForm, name: this.stationForm.name || `${point.name} Smart Lockers`, address: this.stationForm.address || `${point.name} transit station`, latitude: point.latitude, longitude: point.longitude };
  }
  addStation() { this.run(() => this.api.createStation({ ...this.stationForm, latitude: +this.stationForm.latitude, longitude: +this.stationForm.longitude }), 'Smart locker station added'); }
  addCompartment() { this.run(() => this.api.addCompartment(this.compartmentForm), 'Locker compartment added'); }
  deactivateCompartment(compartment: any) { this.run(() => this.api.deactivateCompartment(compartment.id), `Locker ${compartment.compartmentNo} deactivated`); }
  approveLockerExtension(request: any) { this.run(() => this.api.approveLockerExtension(request.id), 'Locker collection time extended'); }
  rejectLockerExtension(request: any) { this.run(() => this.api.rejectLockerExtension(request.id), 'Locker extension request rejected'); }
  regenerateLockerCode(assignment: any) {
    this.busy = true;
    this.api.regenerateLockerCode(assignment.id, 1440).subscribe({
      next: (result) => { this.busy = false; this.generatedLockerCode = result; this.message = 'Previous code revoked and a new collection code generated.'; },
      error: (e) => { this.busy = false; this.message = e.error?.message ?? 'Could not regenerate code'; },
    });
  }

  // Planning
  reportCount(rows: any[] | undefined, key: string) { return rows?.find((row) => row.status === key)?._count ?? 0; }
  maxForecastVolume() { return Math.max(1, ...this.forecasts.map((forecast) => forecast.predictedVolume ?? 0)); }
  generateForecast() { this.run(() => this.api.generateForecast(), 'Forecasts generated and recommendations refreshed'); }

  // Officer nomination
  private loadNomineeFallback() {
    this.admin.getUsers(1, 100).subscribe({
      next: (result) => { this.officerCandidates = (result.users ?? []).filter((user: any) => ['CUSTOMER', 'TRANSIT_OFFICER'].includes(user.role)); this.searchNomineeSuggestions(); },
      error: () => (this.message = 'Could not load users for transit officer nomination'),
    });
  }
  private searchNomineeCandidates() {
    const q = this.nomineeSearch.trim().toLowerCase();
    const available = this.officerCandidates.filter((u) => u.role !== 'TRANSIT_OFFICER');
    return (q ? available.filter((u) => `${u.name} ${u.email} ${u.phone || ''}`.toLowerCase().includes(q)) : available).slice(0, 8);
  }
  onNomineeSearchChange(value: string) { this.nomineeId = ''; this.nomineeSearch = value; this.searchNomineeSuggestions(); }
  searchNomineeSuggestions() { this.nomineeResults = this.searchNomineeCandidates(); this.showNomineeSuggestions = this.nomineeResults.length > 0; this.selectedNomineeIndex = -1; }
  selectNominee(user: any) { this.nomineeId = user.id; this.nomineeSearch = `${user.name} - ${user.email}`; this.nomineeResults = []; this.showNomineeSuggestions = false; }
  nominateOfficer() { if (!this.nomineeId) return; this.run(() => this.api.nominateTransitOfficer(this.nomineeId), 'User nominated as transit officer'); this.nomineeId = ''; this.nomineeSearch = ''; }
  ngOnDestroy() { this.nomineeSearchSubscription?.unsubscribe(); this.workflowSubscription?.unsubscribe(); }
}
