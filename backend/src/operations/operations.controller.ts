import { Body, Controller, Get, Param, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { AlertStatus, SealCondition, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { OperationsService } from './operations.service';

type AuthRequest = Request & { user: { sub: string; id?: string; role: UserRole } };

@Controller('operations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OperationsController {
  constructor(private readonly service: OperationsService) {}
  private user(req: AuthRequest) { return { id: req.user.id ?? req.user.sub, role: req.user.role }; }

  @Post('routes') @Roles('ADMIN')
  createRoute(@Body() body: any, @Request() req: AuthRequest) { return this.service.createRoute(body, this.user(req).id); }
  @Get('routes')
  routes(@Request() req: AuthRequest) { return this.service.listRoutes(this.user(req)); }
  @Patch('routes/:id') @Roles('ADMIN')
  updateRoute(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { return this.service.updateRoute(id, body, this.user(req).id); }

  @Post('transit-points') @Roles('ADMIN')
  createTransitPoint(@Body() body: any, @Request() req: AuthRequest) { return this.service.createTransitPoint(body, this.user(req).id); }
  @Get('transit-points')
  transitPoints(@Request() req: AuthRequest) { return this.service.listTransitPointsDetailed(this.user(req)); }
  @Patch('transit-points/:id') @Roles('ADMIN')
  updateTransitPoint(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { return this.service.updateTransitPoint(id, body, this.user(req).id); }
  @Get('transit-officers/candidates') @Roles('ADMIN')
  officerCandidates() { return this.service.listOfficerCandidates(); }
  @Post('transit-officers/:userId/nominate') @Roles('ADMIN')
  nominateOfficer(@Param('userId') userId: string, @Request() req: AuthRequest) { return this.service.nominateTransitOfficer(userId, this.user(req).id); }
  @Get('transit-officer/workspace') @Roles('TRANSIT_OFFICER')
  officerWorkspace(@Request() req: AuthRequest) { return this.service.officerWorkspace(this.user(req).id); }
  @Get('transit-officer/parcels') @Roles('TRANSIT_OFFICER')
  officerParcels(@Request() req: AuthRequest) { return this.service.officerParcels(this.user(req).id); }
  @Get('transit-officer/drivers') @Roles('TRANSIT_OFFICER')
  officerDrivers(@Request() req: AuthRequest) { return this.service.officerDrivers(this.user(req).id); }
  @Get('transit-officer/lockers') @Roles('TRANSIT_OFFICER')
  officerLockers(@Request() req: AuthRequest) { return this.service.officerLockerStations(this.user(req).id); }
  @Get('transit-officer/users') @Roles('TRANSIT_OFFICER')
  officerUsers(@Query('q') query: string) { return this.service.searchDeliveryUsers(query); }
  @Post('transit-officer/lockers') @Roles('TRANSIT_OFFICER')
  addOfficerLocker(@Body() body: any, @Request() req: AuthRequest) { return this.service.addOfficerLocker(body, this.user(req).id); }
  @Post('transit-officer/batches/:id/inspect-dismiss') @Roles('TRANSIT_OFFICER')
  inspectDismiss(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { return this.service.inspectAndDismissBatch(id, body, this.user(req).id); }

  @Post('batches') @Roles('ADMIN', 'TRANSIT_OFFICER')
  createBatch(@Body() body: any, @Request() req: AuthRequest) { return this.service.createBatch(body, this.user(req).id); }
  @Post('parcels/verify-transit') @Roles('ADMIN', 'TRANSIT_OFFICER')
  verifyTransit(@Body() body: any, @Request() req: AuthRequest) { const user = this.user(req); return this.service.verifyParcelsAtTransit(body, user.id, user.role); }
  @Get('batches') @Roles('ADMIN', 'DRIVER', 'TRANSIT_OFFICER')
  batches(@Request() req: AuthRequest) { return this.service.listBatches(this.user(req)); }
  @Get('batches/:id') @Roles('ADMIN', 'DRIVER', 'TRANSIT_OFFICER')
  batch(@Param('id') id: string, @Request() req: AuthRequest) { return this.service.getBatch(id, this.user(req)); }
  @Post('batches/:id/events') @Roles('ADMIN', 'DRIVER')
  batchEvent(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { return this.service.recordBatchEvent(id, body, this.user(req)); }
  @Post('batches/:id/load') @Roles('ADMIN', 'DRIVER')
  loadBatch(@Param('id') id: string, @Body('parcelIds') parcelIds: string[], @Request() req: AuthRequest) { return this.service.confirmBatchLoad(id, parcelIds, this.user(req)); }
  @Post('batches/:id/remove/:parcelId') @Roles('ADMIN')
  removeFromBatch(@Param('id') id: string, @Param('parcelId') parcelId: string, @Body('reason') reason: string, @Request() req: AuthRequest) { return this.service.removeFromBatch(id, parcelId, this.user(req).id, reason); }
  @Post('batches/:id/split') @Roles('ADMIN')
  splitBatch(@Param('id') id: string, @Body('groups') groups: any[], @Request() req: AuthRequest) { return this.service.splitBatch(id, groups, this.user(req).id); }

  @Post('lockers/stations') @Roles('ADMIN')
  createStation(@Body() body: any, @Request() req: AuthRequest) { return this.service.createLockerStation(body, this.user(req).id); }
  @Get('lockers/stations') @Roles('ADMIN', 'TRANSIT_OFFICER')
  lockerStations(@Request() req: AuthRequest) { return this.service.listLockerStations(this.user(req)); }
  @Post('lockers/compartments') @Roles('ADMIN', 'TRANSIT_OFFICER')
  addCompartment(@Body() body: any, @Request() req: AuthRequest) { const user = this.user(req); return this.service.addCompartment(body, user.id, user.role); }
  @Patch('lockers/compartments/:id') @Roles('ADMIN', 'TRANSIT_OFFICER')
  updateCompartment(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { const user = this.user(req); return this.service.updateLockerCompartment(id, body, user.id, user.role); }
  @Post('lockers/compartments/:id/delete') @Roles('ADMIN', 'TRANSIT_OFFICER')
  deleteCompartment(@Param('id') id: string, @Request() req: AuthRequest) { const user = this.user(req); return this.service.deleteLockerCompartment(id, user.id, user.role); }
  @Post('lockers/compartments/:id/deactivate') @Roles('ADMIN', 'TRANSIT_OFFICER')
  deactivateCompartment(@Param('id') id: string, @Request() req: AuthRequest) { const user = this.user(req); return this.service.deactivateLockerCompartment(id, user.id, user.role); }
  @Post('lockers/assign') @Roles('ADMIN', 'TRANSIT_OFFICER')
  assignLocker(@Body() body: any, @Request() req: AuthRequest) { const user = this.user(req); return this.service.assignLocker(body, user.id, user.role); }
  @Post('lockers/requests') @Roles('CUSTOMER')
  requestLocker(@Body() body: any, @Request() req: AuthRequest) { return this.service.requestLocker(body, this.user(req).id); }
  @Get('lockers/requests') @Roles('ADMIN', 'TRANSIT_OFFICER')
  lockerRequests(@Request() req: AuthRequest) { return this.service.listLockerRequests(this.user(req)); }
  @Post('lockers/requests/:id/approve') @Roles('ADMIN', 'TRANSIT_OFFICER')
  approveLockerRequest(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { const user = this.user(req); return this.service.approveLockerRequest(id, body, user.id, user.role); }
  @Post('lockers/requests/:id/reject') @Roles('ADMIN', 'TRANSIT_OFFICER')
  rejectLockerRequest(@Param('id') id: string, @Request() req: AuthRequest) { const user = this.user(req); return this.service.rejectLockerRequest(id, user.id, user.role); }
  @Post('lockers/:id/extension-requests') @Roles('CUSTOMER')
  requestLockerExtension(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { return this.service.requestLockerExtension(id, +body.requestedMinutes, body.reason, this.user(req).id); }
  @Get('lockers/extension-requests') @Roles('ADMIN', 'TRANSIT_OFFICER')
  lockerExtensionRequests(@Request() req: AuthRequest) { return this.service.listLockerExtensionRequests(this.user(req)); }
  @Post('lockers/extension-requests/:id/approve') @Roles('ADMIN', 'TRANSIT_OFFICER')
  approveLockerExtension(@Param('id') id: string, @Request() req: AuthRequest) { const user = this.user(req); return this.service.reviewLockerExtension(id, true, user.id, user.role); }
  @Post('lockers/extension-requests/:id/reject') @Roles('ADMIN', 'TRANSIT_OFFICER')
  rejectLockerExtension(@Param('id') id: string, @Request() req: AuthRequest) { const user = this.user(req); return this.service.reviewLockerExtension(id, false, user.id, user.role); }
  @Post('lockers/:id/collect')
  @Roles('CUSTOMER', 'ADMIN')
  collectLocker(@Param('id') id: string, @Body('code') code: string, @Request() req: AuthRequest) { return this.service.collectFromLocker(id, code, this.user(req)); }
  @Post('lockers/:id/regenerate-code') @Roles('ADMIN', 'TRANSIT_OFFICER')
  regenerateLockerCode(@Param('id') id: string, @Body('expiresInMinutes') minutes: number, @Request() req: AuthRequest) { const user = this.user(req); return this.service.regenerateLockerCode(id, user.id, minutes, user.role); }
  @Post('lockers/expire') @Roles('ADMIN')
  expireLockers() { return this.service.expireLockerAssignments(); }
  @Post('parcels/:id/direct-delivery') @Roles('ADMIN', 'DRIVER')
  directDelivery(@Param('id') id: string, @Request() req: AuthRequest) { return this.service.completeDirectDelivery(id, this.user(req)); }
  @Post('parcels/:id/transit-pickup') @Roles('CUSTOMER', 'ADMIN')
  transitPickup(@Param('id') id: string, @Request() req: AuthRequest) { return this.service.completeTransitPickup(id, this.user(req)); }

  @Post('seals/:parcelId') @Roles('ADMIN')
  createSeal(@Param('parcelId') parcelId: string, @Request() req: AuthRequest) { return this.service.createSeal(parcelId, this.user(req).id); }
  @Post('seals/scan') @Roles('ADMIN', 'DRIVER')
  scanSeal(@Body() body: { identifier: string; parcelId: string; signature?: string; condition: SealCondition }, @Request() req: AuthRequest) { return this.service.scanSeal(body, this.user(req)); }
  @Get('seals/parcel/:parcelId') @Roles('CUSTOMER', 'DRIVER', 'ADMIN')
  parcelSecurity(@Param('parcelId') parcelId: string, @Request() req: AuthRequest) { return this.service.parcelSecurity(parcelId, this.user(req)); }

  @Get('alerts') @Roles('ADMIN')
  alerts(@Query('status') status?: AlertStatus) { return this.service.listAlerts(status); }
  @Patch('alerts/:id') @Roles('ADMIN')
  resolveAlert(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { return this.service.resolveAlert(id, body, this.user(req).id); }

  @Post('forecasts/generate') @Roles('ADMIN')
  forecast() { return this.service.generateForecast(); }
  @Get('forecasts') @Roles('ADMIN')
  forecasts() { return this.service.listForecasts(); }
  @Get('recommendations/routes') @Roles('ADMIN')
  recommendations() { return this.service.routeRecommendations(); }
  @Get('reports/summary') @Roles('ADMIN')
  report() { return this.service.report(); }
}

@Controller('public/operations')
export class PublicOperationsController {
  constructor(private readonly service: OperationsService) {}

  @Get('routes')
  routes() { return this.service.listRoutes(); }
}
