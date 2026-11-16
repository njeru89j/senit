import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as L from 'leaflet';

/** A station as the operations screen supplies it. */
export interface NetworkStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  active?: boolean;
  contact?: string | null;
  officer?: { name: string; email?: string; phone?: string; address?: string | null } | null;
  officers?: Array<{ name: string; email?: string; phone?: string; address?: string | null }>;
  routes?: Array<{ id: string; name: string }>;
}

/** A route with its stops in travel order. */
export interface NetworkRoute {
  id: string;
  name: string;
  active?: boolean;
  transitPoints?: Array<{ transitPoint?: NetworkStation }>;
}

const ROUTE_COLOURS = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2', '#be185d', '#4d7c0f'];

/**
 * The delivery network on a real map: OpenStreetMap tiles, one marker per station and a line per
 * route. Hovering a station opens a card with its officer, address and routes; the map pans, zooms
 * and works with touch, so it behaves the same on a phone.
 */
@Component({
  selector: 'app-network-map',
  standalone: true,
  imports: [CommonModule],
  template: `<div class="network-map-host" [style.height]="height"><div class="network-map-canvas" #canvas></div></div>`,
  styles: [`
    .network-map-host { position: relative; width: 100%; border-radius: 14px; overflow: hidden; border: 1px solid #e2e8f0; }
    .network-map-canvas { width: 100%; height: 100%; background: #eef2f7; }
  `],
})
export class NetworkMapComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('canvas', { static: true }) canvas!: ElementRef<HTMLDivElement>;
  @Input() stations: NetworkStation[] = [];
  @Input() routes: NetworkRoute[] = [];
  @Input() height = '520px';

  private map: L.Map | null = null;
  private layers: L.Layer[] = [];

  ngAfterViewInit(): void {
    this.map = L.map(this.canvas.nativeElement, { scrollWheelZoom: true, zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors',
    }).addTo(this.map);
    this.map.setView([-0.6, 37.2], 6);
    this.draw();
    // The container is often sized after the tab becomes visible.
    setTimeout(() => this.map?.invalidateSize(), 250);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.map && (changes['stations'] || changes['routes'])) this.draw();
  }

  ngOnDestroy(): void {
    this.map?.remove();
    this.map = null;
  }

  /** Call after the map becomes visible (for example when its tab is opened). */
  refresh(): void {
    this.map?.invalidateSize();
  }

  private mappable(station?: NetworkStation | null): station is NetworkStation {
    return !!station && Number.isFinite(station.latitude) && Number.isFinite(station.longitude) && !(station.latitude === 0 && station.longitude === 0);
  }

  private draw(): void {
    if (!this.map) return;
    for (const layer of this.layers) layer.remove();
    this.layers = [];

    this.routes.forEach((route, index) => {
      const stops = (route.transitPoints ?? []).map((entry) => entry.transitPoint).filter((stop) => this.mappable(stop)) as NetworkStation[];
      if (stops.length < 2) return;
      const line = L.polyline(stops.map((stop) => [stop.latitude, stop.longitude] as L.LatLngTuple), {
        color: ROUTE_COLOURS[index % ROUTE_COLOURS.length],
        weight: 4,
        opacity: route.active === false ? 0.3 : 0.75,
        dashArray: route.active === false ? '6 6' : undefined,
      }).addTo(this.map!);
      line.bindTooltip(route.name, { sticky: true, direction: 'top', className: 'network-map-line-label' });
      this.layers.push(line);
    });

    const stations = this.stations.filter((station) => this.mappable(station));
    for (const station of stations) {
      const inactive = station.active === false;
      const marker = L.circleMarker([station.latitude, station.longitude], {
        radius: 8,
        color: inactive ? '#94a3b8' : '#14213d',
        weight: 2,
        fillColor: inactive ? '#cbd5e1' : '#dbbb02',
        fillOpacity: 1,
      }).addTo(this.map!);
      marker.bindTooltip(station.name, { permanent: true, direction: 'right', offset: [10, 0], className: 'network-map-label' });
      marker.bindPopup(this.card(station), { className: 'network-map-popup', closeButton: true, maxWidth: 320, autoPan: true });
      marker.on('mouseover', () => marker.openPopup());
      marker.on('click', () => marker.openPopup());
      this.layers.push(marker);
    }

    if (stations.length) {
      const bounds = L.latLngBounds(stations.map((station) => [station.latitude, station.longitude] as L.LatLngTuple));
      this.map.fitBounds(bounds, { padding: [40, 40] });
    }
  }

  /** The hover card: who runs the station, where it is and which routes call there. */
  private card(station: NetworkStation): string {
    const officer = station.officer ?? (station.officers ?? [])[0] ?? null;
    const address = officer?.address ?? (station.contact ?? '').split(' · ')[0] ?? '';
    const phone = (station.contact ?? '').split(' · ')[1] ?? officer?.phone ?? '';
    const routes = (station.routes ?? []).map((route) => route.name);
    const escape = (value: string) => value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character] as string));
    return `
      <div class="station-card">
        <header>
          <strong>${escape(station.name)}</strong>
          ${station.active === false ? '<span class="pill inactive">Inactive</span>' : '<span class="pill">Active</span>'}
        </header>
        <dl>
          <div><dt>Officer</dt><dd>${officer ? escape(officer.name) : 'Not nominated yet'}</dd></div>
          ${officer?.email ? `<div><dt>Email</dt><dd>${escape(officer.email)}</dd></div>` : ''}
          ${address ? `<div><dt>Address</dt><dd>${escape(address)}</dd></div>` : ''}
          ${phone ? `<div><dt>Phone</dt><dd>${escape(phone)}</dd></div>` : ''}
          <div><dt>Routes</dt><dd>${routes.length ? escape(routes.join(', ')) : 'On no route yet'}</dd></div>
        </dl>
      </div>`;
  }
}
