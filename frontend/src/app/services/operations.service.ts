import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class OperationsService {
  private readonly base = `${environment.apiUrl}/operations`;
  private readonly publicBase = `${environment.apiUrl}/public/operations`;
  constructor(private http: HttpClient) {}
  routes() { return this.http.get<any[]>(`${this.base}/routes`); }
  publicRoutes() { return this.http.get<any[]>(`${this.publicBase}/routes`); }
  transitPoints() { return this.http.get<any[]>(`${this.base}/transit-points`); }
  transitOfficerCandidates() { return this.http.get<any[]>(`${this.base}/transit-officers/candidates`); }
  nominateTransitOfficer(userId: string) { return this.http.post<any>(`${this.base}/transit-officers/${userId}/nominate`, {}); }
  officerWorkspace() { return this.http.get<any[]>(`${this.base}/transit-officer/workspace`); }
  officerParcels() { return this.http.get<any[]>(`${this.base}/transit-officer/parcels`); }
  officerDrivers() { return this.http.get<any[]>(`${this.base}/transit-officer/drivers`); }
  officerLockers() { return this.http.get<any[]>(`${this.base}/transit-officer/lockers`); }
  officerUsers(query: string) { return this.http.get<any[]>(`${this.base}/transit-officer/users`, { params: { q: query } }); }
  addOfficerLocker(data: any) { return this.http.post(`${this.base}/transit-officer/lockers`, data); }
  inspectAndDismissBatch(id: string, data: any) { return this.http.post<any>(`${this.base}/transit-officer/batches/${id}/inspect-dismiss`, data); }
  createRoute(data: any) { return this.http.post(`${this.base}/routes`, data); }
  updateRoute(id: string, data: any) { return this.http.patch(`${this.base}/routes/${id}`, data); }
  createTransitPoint(data: any) { return this.http.post(`${this.base}/transit-points`, data); }
  updateTransitPoint(id: string, data: any) { return this.http.patch(`${this.base}/transit-points/${id}`, data); }
  createBatch(data: any) { return this.http.post(`${this.base}/batches`, data); }
  verifyParcelsAtTransit(data: any) { return this.http.post(`${this.base}/parcels/verify-transit`, data); }
  batches() { return this.http.get<any[]>(`${this.base}/batches`); }
  batch(id: string) { return this.http.get<any>(`${this.base}/batches/${id}`); }
  recordBatchEvent(id: string, data: any) { return this.http.post(`${this.base}/batches/${id}/events`, data); }
  confirmBatchLoad(id: string, parcelIds: string[]) { return this.http.post(`${this.base}/batches/${id}/load`, { parcelIds }); }
  removeFromBatch(id: string, parcelId: string, reason: string) { return this.http.post(`${this.base}/batches/${id}/remove/${parcelId}`, { reason }); }
  splitBatch(id: string, groups: any[]) { return this.http.post(`${this.base}/batches/${id}/split`, { groups }); }
  createStation(data: any) { return this.http.post(`${this.base}/lockers/stations`, data); }
  lockerStations() { return this.http.get<any[]>(`${this.base}/lockers/stations`); }
  addCompartment(data: any) { return this.http.post(`${this.base}/lockers/compartments`, data); }
  updateCompartment(id: string, data: any) { return this.http.patch(`${this.base}/lockers/compartments/${id}`, data); }
  deleteCompartment(id: string) { return this.http.post(`${this.base}/lockers/compartments/${id}/delete`, {}); }
  deactivateCompartment(id: string) { return this.http.post(`${this.base}/lockers/compartments/${id}/deactivate`, {}); }
  assignLocker(data: any) { return this.http.post(`${this.base}/lockers/assign`, data); }
  requestLocker(data: any) { return this.http.post(`${this.base}/lockers/requests`, data); }
  lockerRequests() { return this.http.get<any[]>(`${this.base}/lockers/requests`); }
  approveLockerRequest(id: string, data: any) { return this.http.post<any>(`${this.base}/lockers/requests/${id}/approve`, data); }
  rejectLockerRequest(id: string) { return this.http.post(`${this.base}/lockers/requests/${id}/reject`, {}); }
  collectLocker(id: string, code: string) { return this.http.post(`${this.base}/lockers/${id}/collect`, { code }); }
  directDelivery(parcelId: string) { return this.http.post(`${this.base}/parcels/${parcelId}/direct-delivery`, {}); }
  transitPickup(parcelId: string) { return this.http.post(`${this.base}/parcels/${parcelId}/transit-pickup`, {}); }
  createSeal(parcelId: string) { return this.http.post<any>(`${this.base}/seals/${parcelId}`, {}); }
  scanSeal(data: any) { return this.http.post<any>(`${this.base}/seals/scan`, data); }
  parcelSecurity(parcelId: string) { return this.http.get<any>(`${this.base}/seals/parcel/${parcelId}`); }
  alerts() { return this.http.get<any[]>(`${this.base}/alerts`); }
  resolveAlert(id: string, data: any) { return this.http.patch(`${this.base}/alerts/${id}`, data); }
  generateForecast() { return this.http.post(`${this.base}/forecasts/generate`, {}); }
  forecasts() { return this.http.get<any[]>(`${this.base}/forecasts`); }
  recommendations() { return this.http.get<any[]>(`${this.base}/recommendations/routes`); }
  report() { return this.http.get<any>(`${this.base}/reports/summary`); }
}
