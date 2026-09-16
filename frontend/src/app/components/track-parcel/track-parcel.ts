import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ParcelsService } from '../../services/parcels.service';

@Component({ selector: 'app-track-parcel', standalone: true, imports: [CommonModule, FormsModule, RouterModule], templateUrl: './track-parcel.html', styleUrl: './track-parcel.css' })
export class TrackParcel {
  trackingNumber = ''; parcel: any = null; error = ''; loading = false;
  constructor(private parcelsService: ParcelsService, private route: ActivatedRoute) {
    const trackingNumber = this.route.snapshot.paramMap.get('trackingNumber');
    if (trackingNumber) {
      this.trackingNumber = trackingNumber;
      this.track();
    }
  }
  track(): void {
    const trackingNumber = this.trackingNumber.trim();
    if (!trackingNumber) { this.error = 'Enter a tracking number.'; return; }
    this.loading = true; this.error = ''; this.parcel = null;
    this.parcelsService.getPublicTracking(trackingNumber).subscribe({
      next: parcel => { this.parcel = parcel; this.loading = false; },
      error: () => { this.error = 'We could not find a parcel with that tracking number.'; this.loading = false; },
    });
  }
  statusLabel(status: string): string { return (status || '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()); }
}
