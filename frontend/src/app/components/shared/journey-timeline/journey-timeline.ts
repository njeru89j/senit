import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';

/**
 * Stop-by-stop parcel journey as returned by the API (`journey` on tracking responses).
 * Renders customer language only; staff-only leg and assignment details are shown when `staff` is set.
 */
@Component({
  selector: 'app-journey-timeline',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="journey" *ngIf="journey">
      <header class="journey-head">
        <div>
          <span class="eyebrow">{{ journey.planned ? 'Planned journey' : 'Journey' }}</span>
          <h3>{{ journey.origin }} <i class="fas fa-arrow-right"></i> {{ journey.destination }}</h3>
        </div>
        <div class="status">
          <strong>{{ journey.statusLabel }}</strong>
          <small>{{ journey.custodyLabel }}</small>
        </div>
      </header>

      <div class="legs" *ngIf="journey.legs?.length > 1 || staff">
        <span class="leg" *ngFor="let leg of journey.legs; let i = index">
          <b>{{ journey.legs.length > 1 ? 'Leg ' + (i + 1) : 'Route' }}</b> {{ leg.from }} → {{ leg.to }}
          <small>{{ leg.route }} · {{ leg.label }}</small>
        </span>
      </div>

      <ol class="stops">
        <li *ngFor="let stop of journey.stops; let last = last" [class.done]="stop.state === 'DONE'" [class.current]="stop.state === 'CURRENT'" [class.pending]="stop.state === 'PENDING'" [class.quiet]="stop.role === 'PASS' && !stop.events.length">
          <span class="dot" aria-hidden="true"><i class="fas" [ngClass]="stop.state === 'DONE' ? 'fa-check' : stop.state === 'CURRENT' ? 'fa-circle' : 'fa-circle-notch'"></i></span>
          <div class="stop-body">
            <div class="stop-title">
              <span>{{ stop.name }}</span>
              <em *ngIf="stop.role !== 'PASS'">{{ roleLabel(stop.role) }}</em>
            </div>
            <ul class="events" *ngIf="stop.events.length">
              <li *ngFor="let event of stop.events">✓ {{ event.label }}<time *ngIf="event.at"> · {{ event.at | date: 'MMM d, HH:mm' }}</time></li>
            </ul>
            <small class="muted" *ngIf="!stop.events.length">{{ stop.role === 'DESTINATION' ? 'Destination' : stop.role === 'PASS' ? (stop.state === 'PENDING' ? 'Pending' : '') : 'Pending' }}</small>
          </div>
        </li>
      </ol>

      <footer class="collection" *ngIf="journey.collection?.deadline || journey.collection?.locker">
        <div *ngIf="journey.collection.locker as locker">
          <i class="fas fa-lock"></i>
          Smart locker {{ locker.compartmentNo }} at {{ locker.station }}
          <span *ngIf="!locker.placed"> — being placed, the code follows</span>
        </div>
        <div *ngIf="journey.collection.deadline && !journey.collection.locker?.placed" [class.overdue]="journey.collection.overdue">
          <i class="fas fa-clock"></i>
          {{ journey.collection.overdue ? 'Collection window ended' : 'Collect by' }} {{ journey.collection.deadline | date: 'MMM d, HH:mm' }}
          <span *ngIf="journey.collection.overdue"> — held securely at the station; bring ID to the counter</span>
        </div>
      </footer>

      <details class="internal" *ngIf="staff && journey.internal">
        <summary>Operational detail</summary>
        <div class="leg-detail" *ngFor="let leg of journey.internal.legs">
          <b>Leg {{ leg.sequence }}</b> {{ leg.from }} → {{ leg.to }} ({{ leg.route }}, {{ leg.direction | lowercase }}) — {{ leg.status }}
          <span *ngIf="leg.noDriverReason"> · waiting: {{ leg.noDriverReason }}</span>
          <ul>
            <li *ngFor="let a of leg.assignments">
              {{ a.driver?.name || 'Driver' }} · {{ a.status }} · offered {{ a.assignedAt | date: 'MMM d, HH:mm' }}
              <span *ngIf="a.acceptanceDeadline && a.status === 'ASSIGNED'"> · accept by {{ a.acceptanceDeadline | date: 'HH:mm' }}</span>
              <span *ngIf="a.rejectionReason"> · "{{ a.rejectionReason }}"</span>
              <span *ngIf="a.cancellationReason"> · {{ a.cancellationReason }}</span>
            </li>
          </ul>
        </div>
      </details>
    </section>
  `,
  styles: [`
    .journey{background:#fff;border:1px solid #e6e9ef;border-radius:14px;padding:18px 20px}
    .journey-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}
    .journey-head h3{margin:2px 0 0;font-size:1.1rem;color:#14213d}.journey-head h3 i{font-size:.8rem;color:#98a2b3;margin:0 4px}
    .eyebrow{font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:#98a2b3;font-weight:600}
    .status{text-align:right}.status strong{display:block;color:#14213d}.status small{color:#667085}
    .legs{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 4px}
    .leg{background:#fdf8dc;border:1px solid #f1e3a0;border-radius:10px;padding:6px 10px;font-size:.85rem}.leg small{display:block;color:#7a6b12}
    .stops{list-style:none;margin:16px 0 0;padding:0}
    .stops>li{position:relative;display:flex;gap:12px;padding:0 0 16px}
    .stops>li:not(:last-child)::before{content:'';position:absolute;left:11px;top:24px;bottom:0;width:2px;background:#e4e7ec}
    .stops>li.done:not(:last-child)::before{background:#DBBB02}
    .dot{flex:0 0 24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:.7rem;background:#f2f4f7;color:#98a2b3;z-index:1}
    .done .dot{background:#DBBB02;color:#fff}.current .dot{background:#14213d;color:#DBBB02;box-shadow:0 0 0 4px #14213d22}
    .stop-title{display:flex;gap:8px;align-items:baseline;font-weight:600;color:#14213d}
    .stop-title em{font-style:normal;font-size:.72rem;font-weight:600;color:#7a6b12;background:#fdf8dc;border-radius:999px;padding:1px 8px}
    .quiet .stop-title{color:#98a2b3;font-weight:500}
    .events{list-style:none;margin:4px 0 0;padding:0;font-size:.85rem;color:#344054}.events time{color:#98a2b3}
    .muted{color:#98a2b3}
    .collection{margin-top:6px;border-top:1px dashed #e4e7ec;padding-top:12px;display:grid;gap:6px;font-size:.9rem;color:#344054}
    .collection i{color:#DBBB02;margin-right:6px}.collection .overdue{color:#b42318}.collection .overdue i{color:#b42318}
    .internal{margin-top:14px;font-size:.82rem;color:#475467}.internal summary{cursor:pointer;font-weight:600}
    .leg-detail{margin-top:8px}.leg-detail ul{margin:4px 0 0 18px;padding:0}
  `],
})
export class JourneyTimelineComponent {
  @Input() journey: any;
  @Input() staff = false;

  roleLabel(role: string): string {
    return role === 'ORIGIN' ? 'Origin' : role === 'TRANSFER' ? 'Transfer station' : role === 'DESTINATION' ? 'Destination' : '';
  }
}
