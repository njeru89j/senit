import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

export type VerificationOutcome = 'VERIFIED' | 'MISSING' | 'DAMAGED' | 'TAMPER_ALERT';

@Injectable({ providedIn: 'root' })
export class OperationsService {
  private readonly base = `${environment.apiUrl}/operations`;
  private readonly publicBase = `${environment.apiUrl}/public/operations`;
  constructor(private http: HttpClient) {}
  // Officers are scoped to their own station; an admin may pass any transit point (or none for every station).
  private station(transitPointId?: string) { return transitPointId ? { params: { transitPointId } } : {}; }

  // Network
  routes() { return this.http.get<any[]>(`${this.base}/routes`); }
  publicRoutes() { return this.http.get<any[]>(`${this.publicBase}/routes`); }
  publicTransitPoints() { return this.http.get<any[]>(`${this.publicBase}/transit-points`); }
  publicCollectLocker(trackingNumber: string, code: string) { return this.http.post<any>(`${this.publicBase}/lockers/collect`, { trackingNumber, code }); }
  transitPoints() { return this.http.get<any[]>(`${this.base}/transit-points`); }
  createRoute(data: { name: string; transitPointIds: string[]; distancesKm?: (number | null)[]; active?: boolean }) { return this.http.post(`${this.base}/routes`, data); }
  updateRoute(id: string, data: { name?: string; active?: boolean; transitPointIds?: string[]; distancesKm?: (number | null)[] }) { return this.http.patch(`${this.base}/routes/${id}`, data); }
  createTransitPoint(data: any) { return this.http.post(`${this.base}/transit-points`, data); }
  updateTransitPoint(id: string, data: any) { return this.http.patch(`${this.base}/transit-points/${id}`, data); }
  transitOfficerCandidates() { return this.http.get<any[]>(`${this.base}/transit-officers/candidates`); }
  nominateTransitOfficer(userId: string) { return this.http.post<any>(`${this.base}/transit-officers/${userId}/nominate`, {}); }

  // Driver trip workflow
  driverWorkspace() { return this.http.get<any>(`${this.base}/driver/workspace`); }
  openTrip(routeId: string, startTransitPointId: string) { return this.http.post<any>(`${this.base}/driver/trips`, { routeId, startTransitPointId }); }
  startTrip(tripId: string) { return this.http.post<any>(`${this.base}/driver/trips/${tripId}/start`, {}); }
  arrive(tripId: string, transitPointId: string) { return this.http.post<any>(`${this.base}/driver/trips/${tripId}/arrive`, { transitPointId }); }
  depart(tripId: string) { return this.http.post<any>(`${this.base}/driver/trips/${tripId}/depart`, {}); }
  drop(tripId: string, assignmentIds?: string[]) { return this.http.post<any>(`${this.base}/driver/trips/${tripId}/drop`, { assignmentIds }); }
  returnParcels(tripId: string, assignmentIds?: string[]) { return this.http.post<any>(`${this.base}/driver/trips/${tripId}/return`, { assignmentIds }); }
  completeTrip(tripId: string) { return this.http.post<any>(`${this.base}/driver/trips/${tripId}/complete`, {}); }
  cancelTrip(tripId: string, reason: string) { return this.http.post<any>(`${this.base}/driver/trips/${tripId}/cancel`, { reason }); }
  acceptAssignment(assignmentId: string) { return this.http.post<any>(`${this.base}/assignments/${assignmentId}/accept`, {}); }
  rejectAssignment(assignmentId: string, reason: string) { return this.http.post<any>(`${this.base}/assignments/${assignmentId}/reject`, { reason }); }
  collectAssignment(assignmentId: string) { return this.http.post<any>(`${this.base}/assignments/${assignmentId}/collect`, {}); }

  // Station work
  stationQueues(transitPointId?: string) { return this.http.get<any>(`${this.base}/transit-officer/queues`, this.station(transitPointId)); }
  verify(transitPointId: string, items: { parcelId: string; outcome: VerificationOutcome; notes?: string }[]) { return this.http.post<any>(`${this.base}/transit-officer/verifications`, { transitPointId, items }); }
  receiveByTracking(transitPointId: string, trackingNumber: string, notes?: string) { return this.http.post<any>(`${this.base}/transit-officer/receive`, { transitPointId, trackingNumber, notes }); }
  confirmParcelReceived(id: string) { return this.http.post<any>(`${this.base}/parcels/${id}/confirm-received`, {}); }
  cancelAssignment(assignmentId: string, reason: string) { return this.http.post<any>(`${this.base}/assignments/${assignmentId}/cancel`, { reason }); }
  eligibleDrivers(legId: string) { return this.http.get<any[]>(`${this.base}/legs/${legId}/eligible-drivers`); }
  assignLeg(legId: string, tripId: string) { return this.http.post<any>(`${this.base}/legs/${legId}/assign`, { tripId }); }
  retryLeg(legId: string) { return this.http.post<any>(`${this.base}/legs/${legId}/retry-assignment`, {}); }
  replan(parcelId: string, reason: string, destinationTransitPointId?: string) { return this.http.post<any>(`${this.base}/parcels/${parcelId}/replan`, { reason, destinationTransitPointId }); }
  correctWeight(parcelId: string, weight: number, reason: string) { return this.http.post<any>(`${this.base}/parcels/${parcelId}/correct-weight`, { weight, reason }); }
  cancelParcel(parcelId: string, reason: string) { return this.http.post<any>(`${this.base}/parcels/${parcelId}/cancel`, { reason }); }
  journey(parcelId: string) { return this.http.get<any>(`${this.base}/parcels/${parcelId}/journey`); }
  transitPickup(parcelId: string) { return this.http.post<any>(`${this.base}/parcels/${parcelId}/transit-pickup`, {}); }
  officerLockers(transitPointId?: string) { return this.http.get<any[]>(`${this.base}/transit-officer/lockers`, this.station(transitPointId)); }
  officerUsers(query: string) { return this.http.get<any[]>(`${this.base}/transit-officer/users`, { params: { q: query } }); }
  addOfficerLocker(data: any) { return this.http.post(`${this.base}/transit-officer/lockers`, data); }

  // Trips (staff)
  trips(status?: string) { return this.http.get<any[]>(`${this.base}/trips`, status ? { params: { status } } : {}); }
  trip(id: string) { return this.http.get<any>(`${this.base}/trips/${id}`); }
  custodyException(tripId: string, reason: string) { return this.http.post<any>(`${this.base}/trips/${tripId}/custody-exception`, { reason }); }

  // Lockers
  createStation(data: any) { return this.http.post(`${this.base}/lockers/stations`, data); }
  lockerStations() { return this.http.get<any[]>(`${this.base}/lockers/stations`); }
  addCompartment(data: any) { return this.http.post(`${this.base}/lockers/compartments`, data); }
  updateCompartment(id: string, data: any) { return this.http.patch(`${this.base}/lockers/compartments/${id}`, data); }
  deleteCompartment(id: string) { return this.http.post(`${this.base}/lockers/compartments/${id}/delete`, {}); }
  deactivateCompartment(id: string) { return this.http.post(`${this.base}/lockers/compartments/${id}/deactivate`, {}); }
  assignLocker(parcelId: string) { return this.http.post<any>(`${this.base}/lockers/assign`, { parcelId }); }
  lockerPlaced(lockerAssignmentId: string) { return this.http.post<any>(`${this.base}/lockers/assignments/${lockerAssignmentId}/placed`, {}); }
  requestLocker(data: { parcelId: string; requestedMinutes?: number }) { return this.http.post<any>(`${this.base}/lockers/requests`, data); }
  collectLocker(id: string, code: string) { return this.http.post(`${this.base}/lockers/${id}/collect`, { code }); }
  requestLockerExtension(id: string, requestedMinutes: number, reason?: string) { return this.http.post(`${this.base}/lockers/${id}/extension-requests`, { requestedMinutes, reason }); }
  lockerExtensionRequests() { return this.http.get<any[]>(`${this.base}/lockers/extension-requests`); }
  approveLockerExtension(id: string) { return this.http.post(`${this.base}/lockers/extension-requests/${id}/approve`, {}); }
  rejectLockerExtension(id: string) { return this.http.post(`${this.base}/lockers/extension-requests/${id}/reject`, {}); }
  regenerateLockerCode(id: string, expiresInMinutes = 1440) { return this.http.post<any>(`${this.base}/lockers/${id}/regenerate-code`, { expiresInMinutes }); }

  // Security and exceptions
  createSeal(parcelId: string) { return this.http.post<any>(`${this.base}/seals/${parcelId}`, {}); }
  scanSeal(data: any) { return this.http.post<any>(`${this.base}/seals/scan`, data); }
  parcelSecurity(parcelId: string) { return this.http.get<any>(`${this.base}/seals/parcel/${parcelId}`); }
  alerts(status?: string) { return this.http.get<any[]>(`${this.base}/alerts`, status ? { params: { status } } : {}); }
  resolveAlert(id: string, data: { status: string; investigation?: string; outcome?: string; action?: 'CONTINUE' | 'CANCEL_PARCEL' | 'REPLAN' }) { return this.http.patch(`${this.base}/alerts/${id}`, data); }

  // Forecasting and reporting
  generateForecast() { return this.http.post(`${this.base}/forecasts/generate`, {}); }
  forecasts() { return this.http.get<any[]>(`${this.base}/forecasts`); }
  recommendations() { return this.http.get<any[]>(`${this.base}/recommendations/routes`); }
  report() { return this.http.get<any>(`${this.base}/reports/summary`); }
}
