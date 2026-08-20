import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subject, Subscription, forkJoin } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { AdminService } from '../../../services/admin.service';
import { OperationsService } from '../../../services/operations.service';
import { SidebarComponent } from '../../shared/sidebar/sidebar';
import { AuthService } from '../../../services/auth.service';

type OperationsTab = 'network' | 'map' | 'batches' | 'lockers' | 'planning';

@Component({ selector: 'app-operations', standalone: true, imports: [CommonModule, FormsModule, SidebarComponent], templateUrl: './operations.html', styleUrls: ['./operations.css', './route-order.css'] })
export class Operations implements OnInit, OnDestroy {
  activeTab: OperationsTab = 'network';
  routes: any[] = []; points: any[] = []; report: any; batches: any[] = []; lockers: any[] = [];
  forecasts: any[] = []; recommendations: any[] = []; drivers: any[] = []; parcels: any[] = []; lockerRequests: any[] = []; lockerExtensionRequests: any[] = [];
  route = { name: '', origin: '', destination: '', transitPointIds: [] as string[] };
  point = { name: '', routeId: '', officerIds: [] as string[] };
  batchForm = { routeId: '', transitPointId: '', driverId: '', parcelIds: [] as string[] };
  lockerForm = { routeId: '', transitPointId: '', parcelId: '', stationId: '', size: 'MEDIUM', expiresInMinutes: 1440 };
  stationForm = { name: '', address: '', latitude: 0, longitude: 0, openingHours: '' };
  compartmentForm = { stationId: '', compartmentNo: '', size: 'MEDIUM' };
  officerCandidates: any[] = []; nomineeId = ''; nomineeSearch = ''; nomineeResults: any[] = [];
  showNomineeSuggestions = false; selectedNomineeIndex = -1; busy = false; message = ''; generatedLockerCode: any = null;
  readonly isTransitOfficer: boolean;
  private nomineeSearch$ = new Subject<string>(); private nomineeSearchSubscription?: Subscription;

  constructor(private api: OperationsService, private admin: AdminService, private activatedRoute: ActivatedRoute, auth: AuthService) {
    this.isTransitOfficer = auth.getCurrentUser()?.role === 'TRANSIT_OFFICER';
  }
  ngOnInit() {
    if (this.isTransitOfficer) this.activeTab = 'batches';
    const initialTab = this.activatedRoute.snapshot.data['initialTab'];
    if (initialTab === 'batches' || initialTab === 'lockers' || initialTab === 'network' || initialTab === 'map' || initialTab === 'planning') this.activeTab = initialTab;
    this.activatedRoute.queryParamMap.subscribe(params => {
      const tab = params.get('tab');
      if (tab === 'batches' || tab === 'lockers' || tab === 'network' || tab === 'map' || tab === 'planning') this.activeTab = tab;
    });
    this.nomineeSearchSubscription = this.nomineeSearch$.pipe(debounceTime(300), distinctUntilChanged()).subscribe(() => this.searchNomineeSuggestions());
    this.refresh();
  }
  refresh() {
    this.api.routes().subscribe(v => { this.routes = v; this.selectAssignedTransitPoint(); });
    this.api.transitPoints().subscribe(v => { this.points = v; this.selectAssignedTransitPoint(); });
    this.api.batches().subscribe(v => this.batches = v);
    this.api.lockerStations().subscribe(v => this.lockers = v);
    this.api.lockerRequests().subscribe(v => this.lockerRequests = v);
    this.api.lockerExtensionRequests().subscribe(v => this.lockerExtensionRequests = v);
    this.admin.getParcels({ limit: 200 }).subscribe(v => this.parcels = v.parcels ?? []);
    if (this.isTransitOfficer) {
      this.api.officerDrivers().subscribe(v => this.drivers = v);
      return;
    }
    this.api.report().subscribe(v => this.report = v);
    this.api.forecasts().subscribe(v => this.forecasts = v);
    this.api.recommendations().subscribe(v => this.recommendations = v);
    this.api.transitOfficerCandidates().subscribe({
      next: v => { this.officerCandidates = v; this.searchNomineeSuggestions(); },
      error: () => this.loadNomineeFallback(),
    });
    this.admin.getDrivers({ limit: 100 }).subscribe(v => this.drivers = v.drivers ?? []);
  }
  switchTab(tab: OperationsTab) { this.activeTab = tab; this.message = ''; }
  mapPoint(point: any) {
    const valid = this.points.filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
    const lats = valid.map(item => item.latitude), lngs = valid.map(item => item.longitude);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    return { x: 60 + ((point.longitude - minLng) / (maxLng - minLng || 1)) * 880, y: 540 - ((point.latitude - minLat) / (maxLat - minLat || 1)) * 480 };
  }
  routeMapPoints(route: any): string {
    return this.orderedRoutePoints(route).map((point: any) => { const p = this.mapPoint(point); return `${p.x},${p.y}`; }).join(' ');
  }
  run(action: () => any, success: string) { this.busy = true; this.message = ''; action().subscribe({ next: () => { this.busy = false; this.message = success; this.refresh(); }, error: (e: any) => { this.busy = false; this.message = e.error?.message ?? 'Operation failed'; } }); }
  addRoute() { this.run(() => this.api.createRoute(this.route), 'Route created'); }
  addPoint() { this.run(() => this.api.createTransitPoint(this.point), 'Transit point created'); }
  get selectedRouteTransitPoints() { const route = this.routes.find(r => r.id === this.batchForm.routeId); return (route?.transitPoints ?? []).map((entry: any) => entry.transitPoint ?? entry).filter((point: any) => point.active); }
  get selectedRouteDrivers() { return this.drivers.filter(driver => { const served = driver.driverProfile?.routesServed ?? driver.routesServed ?? []; return driver.isActive !== false && (served.includes(this.batchForm.routeId) || driver.driverProfile?.currentRouteId === this.batchForm.routeId); }); }
  get selectedLockerRouteTransitPoints() { const route = this.routes.find(r => r.id === this.lockerForm.routeId); return (route?.transitPoints ?? []).map((entry: any) => entry.transitPoint ?? entry).filter((point: any) => point.active); }
  get nominatedTransitOfficers() { return this.officerCandidates.filter(user => user.role === 'TRANSIT_OFFICER'); }
  get availableLockers() { return this.lockers.flatMap(station => (station.compartments ?? []).filter((compartment: any) => compartment.status === 'AVAILABLE').map((compartment: any) => ({ ...compartment, stationName: station.name }))); }
  get availableLockerStations() {
    if (!this.lockerForm.transitPointId) return [];
    return this.lockers.filter(station =>
      (!station.transitPointId || station.transitPointId === this.lockerForm.transitPointId)
      && (station.compartments ?? []).some((compartment: any) => compartment.status === 'AVAILABLE' && compartment.size === this.lockerForm.size),
    );
  }
  get lockerAssignments() { return this.lockers.flatMap(station => (station.compartments ?? []).filter((compartment: any) => !!compartment.assignment).map((compartment: any) => ({ ...compartment.assignment, stationName: station.name, compartmentNo: compartment.compartmentNo, size: compartment.size }))); }
  reportCount(rows: any[] | undefined, key: string) { return rows?.find(row => row.status === key)?._count ?? 0; }
  maxForecastVolume() { return Math.max(1, ...this.forecasts.map(forecast => forecast.predictedVolume ?? 0)); }
  createBatch() { const data = { routeId: this.batchForm.routeId, driverId: this.batchForm.driverId, parcelIds: [...this.batchForm.parcelIds] }; this.run(() => this.api.createBatch(data), `Batch created with ${data.parcelIds.length} parcel(s)`); this.batchForm.parcelIds = []; }
  verifyAtTransit() { const data = { routeId: this.batchForm.routeId, transitPointId: this.batchForm.transitPointId, parcelIds: [...this.batchForm.parcelIds] }; this.run(() => this.api.verifyParcelsAtTransit(data), `${data.parcelIds.length} parcel(s) verified at the transit station in good condition`); this.batchForm.parcelIds = []; }
  toggleBatchParcel(id: string) { const i = this.batchForm.parcelIds.indexOf(id); i >= 0 ? this.batchForm.parcelIds.splice(i, 1) : this.batchForm.parcelIds.push(id); }
  toggleAllBatchParcels() { const ids = this.batchEligibleParcels.map(p => p.id); this.batchForm.parcelIds = this.batchForm.parcelIds.length === ids.length ? [] : ids; }
  get batchEligibleParcels() {
    const route = this.routes.find(item => item.id === this.batchForm.routeId);
    if (!route) return [];
    const locations = [route.origin, route.destination, ...this.selectedRouteTransitPoints.map((point: any) => point.name)].map(value => value?.trim().toLowerCase());
    return this.parcels.filter(p => ['collected', 'in_transit', 'at_transit_point'].includes(p.status) && locations.includes((p.currentLocation || p.pickupAddress || '').trim().toLowerCase()) && (!this.isTransitOfficer || p.currentTransitPointId === this.batchForm.transitPointId));
  }
  onBatchRouteChange() { this.batchForm.transitPointId = ''; this.batchForm.driverId = ''; this.batchForm.parcelIds = []; }
  get lockerEligibleParcels() { return this.parcels.filter(p => p.status === 'at_destination' && p.routeId === this.lockerForm.routeId); }
  onLockerRouteChange() { this.lockerForm.transitPointId = ''; this.lockerForm.parcelId = ''; this.lockerForm.stationId = ''; }
  onLockerTransitPointChange() { this.lockerForm.parcelId = ''; this.lockerForm.stationId = ''; }
  onLockerSizeChange() { this.lockerForm.stationId = ''; }
  assignLocker() { this.busy = true; this.message = ''; this.generatedLockerCode = null; this.api.assignLocker({ parcelId: this.lockerForm.parcelId, stationId: this.lockerForm.stationId, routeId: this.lockerForm.routeId, transitPointId: this.lockerForm.transitPointId, size: this.lockerForm.size, expiresInMinutes: +this.lockerForm.expiresInMinutes }).subscribe({ next: (result: any) => { this.busy = false; this.generatedLockerCode = result; this.message = 'Locker assigned. Share the collection code with the parcel owner.'; this.refresh(); }, error: (e: any) => { this.busy = false; this.message = e.error?.message ?? 'Could not assign locker'; } }); }
  approveLockerRequest(request: any) { const stationId = request.stationId || this.lockers[0]?.id; if (!stationId) { this.message = 'Add a locker station before approving requests'; return; } this.busy = true; this.api.approveLockerRequest(request.id, { stationId, size: request.size }).subscribe({ next: (result: any) => { this.busy = false; this.generatedLockerCode = result; this.message = 'Locker request approved; collection code sent to the recipient.'; this.refresh(); }, error: (e: any) => { this.busy = false; this.message = e.error?.message ?? 'Could not approve request'; } }); }
  approveLockerExtension(request: any) { this.run(() => this.api.approveLockerExtension(request.id), 'Locker collection time extended'); }
  rejectLockerExtension(request: any) { this.run(() => this.api.rejectLockerExtension(request.id), 'Locker extension request rejected'); }
  rejectLockerRequest(request: any) { this.run(() => this.api.rejectLockerRequest(request.id), 'Locker request rejected'); }
  regenerateLockerCode(assignment: any) { this.busy = true; this.api.regenerateLockerCode(assignment.id, 1440).subscribe({ next: result => { this.busy = false; this.generatedLockerCode = { assignment, ...result }; this.message = 'Previous code revoked and a new collection code generated.'; }, error: e => { this.busy = false; this.message = e.error?.message ?? 'Could not regenerate code'; } }); }
  addStation() { this.run(() => this.api.createStation({ ...this.stationForm, latitude: +this.stationForm.latitude, longitude: +this.stationForm.longitude }), 'Smart locker station added'); }
  addCompartment() { this.run(() => this.api.addCompartment(this.compartmentForm), 'Locker compartment added'); }
  deactivateCompartment(compartment: any) { this.run(() => this.api.deactivateCompartment(compartment.id), `Locker ${compartment.compartmentNo} deactivated`); }
  generateForecast() { this.run(() => this.api.generateForecast(), 'Forecasts generated and recommendations refreshed'); }
  toggleRoute(route: any) { this.run(() => this.api.updateRoute(route.id, { active: !route.active }), `Route ${route.active ? 'deactivated' : 'activated'}`); }
  togglePoint(point: any) { this.run(() => this.api.updateTransitPoint(point.id, { active: !point.active }), `Transit point ${point.active ? 'deactivated' : 'activated'}`); }
  toggleRoutePoint(id: string) { const i = this.route.transitPointIds.indexOf(id); i >= 0 ? this.route.transitPointIds.splice(i, 1) : this.route.transitPointIds.push(id); }
  orderedRoutePoints(route: any) { return (route.transitPoints ?? []).map((entry: any) => entry.transitPoint ?? entry); }
  moveRoutePoint(route: any, index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= route.transitPoints.length) return;
    [route.transitPoints[index], route.transitPoints[target]] = [route.transitPoints[target], route.transitPoints[index]];
    route.orderDirty = true;
  }
  saveRouteOrder(route: any) {
    const transitPointIds = this.orderedRoutePoints(route).map((point: any) => point.id);
    this.run(() => this.api.updateRoute(route.id, { transitPointIds }), `Transit point order saved for ${route.name}`);
    route.orderDirty = false;
  }
  private selectAssignedTransitPoint() {
    if (!this.isTransitOfficer || this.points.length !== 1) return;
    const point = this.points[0];
    const routeId = point.routeId || this.routes.find(route => (route.transitPoints ?? []).some((entry: any) => (entry.transitPoint ?? entry).id === point.id))?.id || '';
    if (!routeId) return;
    this.batchForm.routeId = routeId;
    this.batchForm.transitPointId = point.id;
    this.lockerForm.routeId = routeId;
    this.lockerForm.transitPointId = point.id;
  }
  private loadNomineeFallback() {
    this.admin.getUsers(1, 100).subscribe({
      next: result => { this.officerCandidates = (result.users ?? []).filter((user: any) => ['CUSTOMER', 'TRANSIT_OFFICER'].includes(user.role)); this.searchNomineeSuggestions(); },
      error: () => this.message = 'Could not load users for transit officer nomination',
    });
  }
  private searchNomineeCandidates() {
    const q = this.nomineeSearch.trim().toLowerCase();
    const available = this.officerCandidates.filter(u => u.role !== 'TRANSIT_OFFICER');
    return (q ? available.filter(u => `${u.name} ${u.email} ${u.phone || ''}`.toLowerCase().includes(q)) : available).slice(0, 8);
  }
  onNomineeSearchChange(value: string) { this.nomineeId = ''; this.nomineeSearch = value; this.searchNomineeSuggestions(); }
  searchNomineeSuggestions() { this.nomineeResults = this.searchNomineeCandidates(); this.showNomineeSuggestions = this.nomineeResults.length > 0; this.selectedNomineeIndex = -1; }
  selectNominee(user: any) { this.nomineeId = user.id; this.nomineeSearch = `${user.name} - ${user.email}`; this.nomineeResults = []; this.showNomineeSuggestions = false; }
  onNomineeFocus() { this.searchNomineeSuggestions(); } onNomineeBlur() { setTimeout(() => this.showNomineeSuggestions = false, 200); }
  onNomineeKeyDown(event: KeyboardEvent) { if (!this.showNomineeSuggestions || !this.nomineeResults.length) return; if (event.key === 'ArrowDown') { event.preventDefault(); this.selectedNomineeIndex = Math.min(this.selectedNomineeIndex + 1, this.nomineeResults.length - 1); } else if (event.key === 'ArrowUp') { event.preventDefault(); this.selectedNomineeIndex = Math.max(this.selectedNomineeIndex - 1, 0); } else if (event.key === 'Enter' && this.selectedNomineeIndex >= 0) { event.preventDefault(); this.selectNominee(this.nomineeResults[this.selectedNomineeIndex]); } else if (event.key === 'Escape') this.showNomineeSuggestions = false; }
  nominateOfficer() { if (!this.nomineeId) return; this.run(() => this.api.nominateTransitOfficer(this.nomineeId), 'User nominated as transit officer'); this.nomineeId = ''; this.nomineeSearch = ''; }
  ngOnDestroy() { this.nomineeSearchSubscription?.unsubscribe(); }
}
