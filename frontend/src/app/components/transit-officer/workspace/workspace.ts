import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar';
import { OperationsService } from '../../../services/operations.service';

@Component({ selector: 'app-transit-workspace', standalone: true, imports: [CommonModule, FormsModule, SidebarComponent], templateUrl: './workspace.html', styleUrl: './workspace.css' })
export class TransitWorkspace implements OnInit {
  batches: any[] = []; parcels: any[] = []; lockers: any[] = []; drivers: any[] = []; routes: any[] = []; points: any[] = [];
  selected: any = null; inspections: Record<string, { condition: string; disposition: 'CONTINUE' | 'DIVERT'; notes: string }> = {}; busy = false; message = ''; tab = 'batches';
  handoff = { routeId: '', transitPointId: '', driverId: '', parcelIds: [] as string[] };
  locker = { parcelId: '', stationId: '', size: 'MEDIUM', expiresInMinutes: 1440 }; lockerCode = '';
  compartment = { stationId: '', compartmentNo: '', size: 'MEDIUM' }; editingCompartment: any = null;
  constructor(private api: OperationsService, private route: ActivatedRoute) {}
  ngOnInit() { const page = this.route.snapshot.routeConfig?.path; this.tab = page === 'lockers' ? 'lockers' : page === 'enroute' ? 'handoffs' : page === 'manage-lockers' ? 'manage-lockers' : page === 'dashboard' ? 'drivers' : 'batches'; this.load(); }
  load() {
    this.api.officerWorkspace().subscribe({ next: value => this.batches = value, error: (e: any) => this.message = e.error?.message ?? 'Could not load transit workspace' });
    this.api.officerParcels().subscribe(value => this.parcels = value);
    this.api.officerLockers().subscribe({ next: value => this.lockers = value, error: (e: any) => this.message = e.error?.message ?? 'Could not load lockers for your transit point' });
    this.api.routes().subscribe(value => this.routes = value);
    this.api.transitPoints().subscribe(value => { this.points = value; if (!this.handoff.transitPointId && value.length === 1) this.handoff.transitPointId = value[0].id; });
    this.api.officerDrivers().subscribe(value => this.drivers = value);
  }
  open(batch: any) { this.selected = batch; this.inspections = {}; for (const parcel of batch.parcels) this.inspections[parcel.id] = { condition: '', disposition: 'CONTINUE', notes: '' }; }
  allInspected() { return !!this.selected?.parcels?.length && this.selected.parcels.every((parcel: any) => !!this.inspections[parcel.id]?.condition); }
  dismiss() {
    if (!this.selected || !this.allInspected()) return;
    this.busy = true; this.message = '';
    const data = { transitPointId: this.selected.transitPoint.id, inspections: this.selected.parcels.map((parcel: any) => ({ parcelId: parcel.id, ...this.inspections[parcel.id] })) };
    this.api.inspectAndDismissBatch(this.selected.id, data).subscribe({ next: (result: any) => { this.busy = false; this.message = `Batch verified: ${result.continuing} continuing, ${result.diverted} diverted, ${result.held} held for review.`; this.selected = null; this.load(); }, error: (e: any) => { this.busy = false; this.message = e.error?.message ?? 'Inspection could not be completed'; } });
  }
  switchTab(tab: string) { this.tab = tab; this.message = ''; }
  get handoffParcels() { return this.parcels.filter(parcel => parcel.status === 'at_transit_point' && (!this.handoff.transitPointId || parcel.currentTransitPointId === this.handoff.transitPointId)); }
  get eligibleLockerParcels() { return this.parcels.filter(parcel => parcel.status === 'at_transit_point' || parcel.status === 'at_destination'); }
  get availableTransitPoints() { return this.lockers.filter(point => (point.compartments || []).some((c: any) => c.status === 'AVAILABLE' && c.size === this.locker.size)); }
  get assignedTransitPoint() { return this.points[0] ?? null; }
  get lockerRecords() { return this.lockers.flatMap(station => (station.compartments || []).map((compartment: any) => ({ ...compartment, transitPointName: station.name }))); }
  routeName(routeId: string) { return this.routes.find(route => route.id === routeId)?.name || 'Route'; }
  toggleParcel(id: string) { const i = this.handoff.parcelIds.indexOf(id); i < 0 ? this.handoff.parcelIds.push(id) : this.handoff.parcelIds.splice(i, 1); }
  handOff() {
    if (!this.handoff.routeId || !this.handoff.transitPointId || !this.handoff.driverId || !this.handoff.parcelIds.length) return;
    this.busy = true; this.message = '';
    this.api.verifyParcelsAtTransit(this.handoff).subscribe({ next: () => this.api.createBatch({ routeId: this.handoff.routeId, driverId: this.handoff.driverId, parcelIds: this.handoff.parcelIds }).subscribe({ next: () => { this.busy = false; this.message = 'Handoff recorded, onward batch created, and the new driver assigned.'; this.handoff.parcelIds = []; this.load(); }, error: (e: any) => { this.busy = false; this.message = e.error?.message ?? 'Parcel verified, but batch creation failed'; } }), error: (e: any) => { this.busy = false; this.message = e.error?.message ?? 'Could not verify the parcel handoff'; } });
  }
  assignLocker() {
    this.busy = true; this.lockerCode = '';
    this.api.assignLocker({ ...this.locker, expiresInMinutes: +this.locker.expiresInMinutes }).subscribe({ next: (result: any) => { this.busy = false; this.lockerCode = result.collectionCode; this.message = 'Locker assigned and collection code generated.'; this.load(); }, error: (e: any) => { this.busy = false; this.message = e.error?.message ?? 'Could not assign locker'; } });
  }
  addCompartment() { this.run(() => this.api.addOfficerLocker({ compartmentNo: this.compartment.compartmentNo, size: this.compartment.size }), 'Locker added'); }
  editCompartment(compartment: any) { this.editingCompartment = { ...compartment }; }
  saveCompartment() { this.run(() => this.api.updateCompartment(this.editingCompartment.id, { compartmentNo: this.editingCompartment.compartmentNo, size: this.editingCompartment.size }), 'Locker updated'); this.editingCompartment = null; }
  deleteCompartment(compartment: any) { if (!confirm(`Delete locker ${compartment.compartmentNo}?`)) return; this.run(() => this.api.deleteCompartment(compartment.id), 'Locker deleted'); }
  deactivateCompartment(compartment: any) { if (!confirm(`Deactivate locker ${compartment.compartmentNo}?`)) return; this.run(() => this.api.deactivateCompartment(compartment.id), 'Locker deactivated'); }
  run(action: () => any, success: string) { this.busy = true; this.message = ''; action().subscribe({ next: () => { this.busy = false; this.message = success; this.load(); }, error: (e: any) => { this.busy = false; this.message = e.error?.message ?? 'Operation failed'; } }); }
}
