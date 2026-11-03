import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ParcelsService } from '../../services/parcels.service';
import { OperationsService } from '../../services/operations.service';
import { parcelStatusLabel } from '../../utils/parcel-status';

@Component({ selector: 'app-track-parcel', standalone: true, imports: [CommonModule, FormsModule, RouterModule], templateUrl: './track-parcel.html', styleUrl: './track-parcel.css' })
export class TrackParcel {
  trackingNumber = ''; parcel: any = null; error = ''; loading = false;
  /** Guest locker collection: the tracking number plus the emailed code opens the locker. */
  collectionCode = ''; collecting = false; collectionMessage = ''; collectionError = '';
  constructor(private parcelsService: ParcelsService, private operationsService: OperationsService, private route: ActivatedRoute) {
    const trackingNumber = this.route.snapshot.paramMap.get('trackingNumber');
    if (trackingNumber) {
      this.trackingNumber = trackingNumber;
      this.track();
    }
  }
  track(): void {
    const trackingNumber = this.trackingNumber.trim();
    if (!trackingNumber) { this.error = 'Enter a tracking number.'; return; }
    this.loading = true; this.error = '';
    // Keep the current result on screen while refreshing the same parcel (e.g. after a locker collection).
    if (this.parcel?.trackingNumber !== trackingNumber) { this.parcel = null; this.collectionMessage = ''; }
    this.parcelsService.getPublicTracking(trackingNumber).subscribe({
      next: parcel => { this.parcel = parcel; this.loading = false; },
      error: () => { this.error = 'We could not find a parcel with that tracking number.'; this.loading = false; },
    });
  }
  statusLabel(status: string): string { return parcelStatusLabel(status); }
  /** One row per status change: repeated rows for the same status (driver offers, acceptances) collapse to when it began. */
  get updates(): any[] {
    const rows: any[] = this.parcel?.statusHistory ?? [];
    return rows.filter((row, index) => rows[index + 1]?.status !== row.status);
  }
  collectFromLocker(): void {
    const code = this.collectionCode.trim();
    if (!/^\d{6}$/.test(code)) { this.collectionError = 'Enter the 6-digit code from your collection email.'; return; }
    this.collecting = true; this.collectionError = ''; this.collectionMessage = '';
    this.operationsService.publicCollectLocker(this.parcel.trackingNumber, code).subscribe({
      next: () => { this.collecting = false; this.collectionCode = ''; this.collectionMessage = 'Locker opened. Your parcel collection is complete.'; this.track(); },
      error: (e: any) => { this.collecting = false; this.collectionError = e.error?.message ?? 'The code could not be accepted.'; },
    });
  }
}
