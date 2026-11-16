import { Body, Controller, Get, Param, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { AlertStatus, SealCondition, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { OperationsService } from './operations.service';
import { DispatchService } from './workflow/dispatch.service';
import { JourneyService } from './workflow/journey.service';
import { TripsService } from './workflow/trips.service';
import { VerificationService, VerificationItem } from './workflow/verification.service';
import { CollectionService } from './workflow/collection.service';
import { StationQueuesService } from './workflow/station-queues.service';

type AuthRequest = Request & { user: { sub: string; id?: string; role: UserRole } };
const actor = (req: AuthRequest) => ({ id: req.user.id ?? req.user.sub, role: req.user.role });

@Controller('operations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OperationsController {
  constructor(
    private readonly service: OperationsService,
    private readonly journey: JourneyService,
    private readonly collection: CollectionService,
  ) {}

  // Network administration
  @Post('routes') @Roles('ADMIN')
  createRoute(@Body() body: any, @Request() req: AuthRequest) { return this.service.createRoute(body, actor(req).id); }
  @Get('routes')
  routes(@Request() req: AuthRequest) { return this.service.listRoutes(actor(req)); }
  @Patch('routes/:id') @Roles('ADMIN')
  updateRoute(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { return this.service.updateRoute(id, body, actor(req).id); }

  @Post('transit-points') @Roles('ADMIN')
  createTransitPoint(@Body() body: any, @Request() req: AuthRequest) { return this.service.createTransitPoint(body, actor(req).id); }
  @Get('transit-points')
  transitPoints(@Request() req: AuthRequest) { return this.service.listTransitPointsDetailed(actor(req)); }
  @Patch('transit-points/:id') @Roles('ADMIN')
  updateTransitPoint(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { return this.service.updateTransitPoint(id, body, actor(req).id); }
  @Get('transit-officers/candidates') @Roles('ADMIN')
  officerCandidates() { return this.service.listOfficerCandidates(); }
  @Post('transit-officers/:userId/nominate') @Roles('ADMIN')
  nominateOfficer(@Param('userId') userId: string, @Request() req: AuthRequest) { return this.service.nominateTransitOfficer(userId, actor(req).id); }

  @Get('transit-officer/lockers') @Roles('TRANSIT_OFFICER')
  officerLockers(@Request() req: AuthRequest, @Query('transitPointId') transitPointId?: string) { return this.service.officerLockerStations(actor(req), transitPointId || undefined); }
  @Get('transit-officer/users') @Roles('TRANSIT_OFFICER')
  officerUsers(@Query('q') query: string) { return this.service.searchDeliveryUsers(query); }
  @Post('transit-officer/lockers') @Roles('TRANSIT_OFFICER')
  addOfficerLocker(@Body() body: any, @Request() req: AuthRequest) { return this.service.addOfficerLocker(body, actor(req)); }

  // Origin confirmation (officer at the origin station, or admin)
  @Post('parcels/:id/confirm-received') @Roles('TRANSIT_OFFICER')
  confirmReceived(@Param('id') id: string, @Request() req: AuthRequest) { return this.journey.confirmAtOrigin(id, actor(req)); }

  // Lockers
  @Post('lockers/stations') @Roles('ADMIN')
  createStation(@Body() body: any, @Request() req: AuthRequest) { return this.service.createLockerStation(body, actor(req).id); }
  @Get('lockers/stations') @Roles('TRANSIT_OFFICER')
  lockerStations(@Request() req: AuthRequest) { return this.service.listLockerStations(actor(req)); }
  @Post('lockers/compartments') @Roles('TRANSIT_OFFICER')
  addCompartment(@Body() body: any, @Request() req: AuthRequest) { const user = actor(req); return this.service.addCompartment(body, user.id, user.role); }
  @Patch('lockers/compartments/:id') @Roles('TRANSIT_OFFICER')
  updateCompartment(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { const user = actor(req); return this.service.updateLockerCompartment(id, body, user.id, user.role); }
  @Post('lockers/compartments/:id/delete') @Roles('TRANSIT_OFFICER')
  deleteCompartment(@Param('id') id: string, @Request() req: AuthRequest) { const user = actor(req); return this.service.deleteLockerCompartment(id, user.id, user.role); }
  @Post('lockers/compartments/:id/deactivate') @Roles('TRANSIT_OFFICER')
  deactivateCompartment(@Param('id') id: string, @Request() req: AuthRequest) { const user = actor(req); return this.service.deactivateLockerCompartment(id, user.id, user.role); }
  @Post('lockers/assign') @Roles('TRANSIT_OFFICER')
  assignLocker(@Body() body: any, @Request() req: AuthRequest) { return this.collection.assignLockerManually(body, actor(req)); }
  @Post('lockers/assignments/:id/placed') @Roles('TRANSIT_OFFICER')
  lockerPlaced(@Param('id') id: string, @Request() req: AuthRequest) { return this.collection.confirmPlaced(id, actor(req)); }
  @Post('lockers/requests') @Roles('CUSTOMER')
  requestLocker(@Body() body: any, @Request() req: AuthRequest) { return this.collection.requestLocker(body, actor(req).id); }
  @Post('lockers/:id/extension-requests') @Roles('CUSTOMER')
  requestLockerExtension(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { return this.service.requestLockerExtension(id, +body.requestedMinutes, body.reason, actor(req).id); }
  @Get('lockers/extension-requests') @Roles('TRANSIT_OFFICER')
  lockerExtensionRequests(@Request() req: AuthRequest) { return this.service.listLockerExtensionRequests(actor(req)); }
  @Post('lockers/extension-requests/:id/approve') @Roles('TRANSIT_OFFICER')
  approveLockerExtension(@Param('id') id: string, @Request() req: AuthRequest) { const user = actor(req); return this.service.reviewLockerExtension(id, true, user.id, user.role); }
  @Post('lockers/extension-requests/:id/reject') @Roles('TRANSIT_OFFICER')
  rejectLockerExtension(@Param('id') id: string, @Request() req: AuthRequest) { const user = actor(req); return this.service.reviewLockerExtension(id, false, user.id, user.role); }
  @Post('lockers/:id/collect') @Roles('CUSTOMER', 'TRANSIT_OFFICER')
  collectLocker(@Param('id') id: string, @Body('code') code: string, @Request() req: AuthRequest) { return this.collection.collectFromLocker(id, code, actor(req)); }
  @Post('lockers/:id/regenerate-code') @Roles('TRANSIT_OFFICER')
  regenerateLockerCode(@Param('id') id: string, @Body('expiresInMinutes') minutes: number, @Request() req: AuthRequest) { const user = actor(req); return this.service.regenerateLockerCode(id, user.id, minutes, user.role); }
  @Post('lockers/expire') @Roles('ADMIN')
  expireLockers() { return this.collection.expireLockerCodes(); }

  // Station collection (counter)
  @Post('parcels/:id/transit-pickup') @Roles('CUSTOMER', 'TRANSIT_OFFICER')
  transitPickup(@Param('id') id: string, @Request() req: AuthRequest) { return this.collection.counterHandover(id, actor(req)); }

  // Security
  @Post('seals/:parcelId') @Roles('ADMIN')
  createSeal(@Param('parcelId') parcelId: string, @Request() req: AuthRequest) { return this.service.createSeal(parcelId, actor(req).id); }
  @Post('seals/scan') @Roles('TRANSIT_OFFICER', 'DRIVER')
  scanSeal(@Body() body: { identifier: string; parcelId: string; signature?: string; condition: SealCondition; transitPointId?: string }, @Request() req: AuthRequest) { return this.service.scanSeal(body, actor(req)); }
  @Get('seals/parcel/:parcelId') @Roles('CUSTOMER', 'DRIVER', 'ADMIN')
  parcelSecurity(@Param('parcelId') parcelId: string, @Request() req: AuthRequest) { return this.service.parcelSecurity(parcelId, actor(req)); }

  // Exceptions: admins everywhere, officers at their stations
  @Get('alerts') @Roles('TRANSIT_OFFICER')
  alerts(@Request() req: AuthRequest, @Query('status') status?: AlertStatus) { return this.service.listAlerts(actor(req), status || undefined); }
  @Patch('alerts/:id') @Roles('TRANSIT_OFFICER')
  resolveAlert(@Param('id') id: string, @Body() body: any, @Request() req: AuthRequest) { return this.journey.resolveException(id, actor(req), body); }

  // Forecasting and reporting
  @Post('forecasts/generate') @Roles('ADMIN')
  forecast() { return this.service.generateForecast(); }
  @Get('forecasts') @Roles('ADMIN')
  forecasts() { return this.service.listForecasts(); }
  @Get('recommendations/routes') @Roles('ADMIN')
  recommendations() { return this.service.routeRecommendations(); }
  @Get('reports/summary') @Roles('ADMIN')
  report() { return this.service.report(); }
}

/** The parcel journey: driver trips and assignments, station verification and queues, exceptions. */
@Controller('operations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WorkflowController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly journey: JourneyService,
    private readonly trips: TripsService,
    private readonly verification: VerificationService,
    private readonly queues: StationQueuesService,
  ) {}

  // Driver
  @Get('driver/workspace') @Roles('DRIVER')
  driverWorkspace(@Request() req: AuthRequest) { return this.trips.workspace(actor(req).id); }
  @Post('driver/trips') @Roles('DRIVER')
  openTrip(@Body() body: { routeId: string; startTransitPointId: string }, @Request() req: AuthRequest) { return this.trips.openTrip(actor(req).id, body); }
  @Post('driver/trips/:id/start') @Roles('DRIVER')
  startTrip(@Param('id') id: string, @Request() req: AuthRequest) { return this.trips.startTrip(id, actor(req).id); }
  @Post('driver/trips/:id/arrive') @Roles('DRIVER')
  arrive(@Param('id') id: string, @Body('transitPointId') transitPointId: string, @Request() req: AuthRequest) { return this.trips.arrive(id, actor(req).id, transitPointId); }
  @Post('driver/trips/:id/depart') @Roles('DRIVER')
  depart(@Param('id') id: string, @Request() req: AuthRequest) { return this.trips.depart(id, actor(req).id); }
  @Post('driver/trips/:id/drop') @Roles('DRIVER')
  drop(@Param('id') id: string, @Body('assignmentIds') assignmentIds: string[] | undefined, @Request() req: AuthRequest) { return this.trips.drop(id, actor(req).id, assignmentIds); }
  @Post('driver/trips/:id/return') @Roles('DRIVER')
  returnParcels(@Param('id') id: string, @Body('assignmentIds') assignmentIds: string[] | undefined, @Request() req: AuthRequest) { return this.trips.returnToStation(id, actor(req).id, assignmentIds); }
  @Post('driver/trips/:id/complete') @Roles('DRIVER')
  complete(@Param('id') id: string, @Request() req: AuthRequest) { return this.trips.complete(id, actor(req).id); }
  @Post('driver/trips/:id/cancel') @Roles('DRIVER', 'ADMIN')
  cancelTrip(@Param('id') id: string, @Body('reason') reason: string, @Request() req: AuthRequest) { return this.trips.cancel(id, actor(req), reason); }
  @Post('assignments/:id/accept') @Roles('DRIVER')
  accept(@Param('id') id: string, @Request() req: AuthRequest) { return this.dispatch.accept(id, actor(req).id); }
  @Post('assignments/:id/reject') @Roles('DRIVER')
  reject(@Param('id') id: string, @Body('reason') reason: string, @Request() req: AuthRequest) { return this.dispatch.reject(id, actor(req).id, reason); }
  @Post('assignments/:id/collect') @Roles('DRIVER')
  collect(@Param('id') id: string, @Request() req: AuthRequest) { return this.trips.collect(id, actor(req).id); }

  // Station work
  @Get('transit-officer/queues') @Roles('TRANSIT_OFFICER')
  stationQueues(@Request() req: AuthRequest, @Query('transitPointId') transitPointId?: string) { return this.queues.queues(actor(req), transitPointId || undefined); }
  @Post('transit-officer/verifications') @Roles('TRANSIT_OFFICER')
  verify(@Body() body: { transitPointId: string; items: VerificationItem[] }, @Request() req: AuthRequest) { return this.verification.verify(actor(req), body); }
  @Post('transit-officer/receive') @Roles('TRANSIT_OFFICER')
  receive(@Body() body: { transitPointId: string; trackingNumber: string; notes?: string }, @Request() req: AuthRequest) { return this.verification.receiveByTracking(actor(req), body); }
  @Post('assignments/:id/cancel') @Roles('TRANSIT_OFFICER')
  cancelAssignment(@Param('id') id: string, @Body('reason') reason: string, @Request() req: AuthRequest) { return this.dispatch.cancelByStaff(id, actor(req), reason); }
  @Get('legs/:id/eligible-drivers') @Roles('TRANSIT_OFFICER')
  eligibleDrivers(@Param('id') id: string, @Request() req: AuthRequest) { return this.dispatch.eligibleDrivers(id, actor(req)); }
  @Post('legs/:id/assign') @Roles('TRANSIT_OFFICER')
  manualAssign(@Param('id') id: string, @Body('tripId') tripId: string, @Request() req: AuthRequest) { return this.dispatch.manualAssign(id, tripId, actor(req)); }
  @Post('legs/:id/retry-assignment') @Roles('TRANSIT_OFFICER')
  retry(@Param('id') id: string, @Request() req: AuthRequest) { return this.dispatch.retryLeg(id, actor(req)); }
  @Post('parcels/:id/replan') @Roles('TRANSIT_OFFICER')
  replan(@Param('id') id: string, @Body() body: { reason: string; destinationTransitPointId?: string }, @Request() req: AuthRequest) { return this.journey.replan(id, actor(req), body); }
  @Post('parcels/:id/correct-weight') @Roles('TRANSIT_OFFICER')
  correctWeight(@Param('id') id: string, @Body() body: { weight: number; reason: string }, @Request() req: AuthRequest) { return this.journey.correctWeight(id, +body.weight, body.reason, actor(req)); }
  @Post('parcels/:id/cancel') @Roles('TRANSIT_OFFICER')
  cancelParcel(@Param('id') id: string, @Body('reason') reason: string, @Request() req: AuthRequest) { return this.journey.cancelParcel(id, actor(req), reason); }
  @Get('parcels/:id/journey') @Roles('TRANSIT_OFFICER')
  journeyView(@Param('id') id: string) { return this.journey.journeyView(id, 'staff'); }

  // Trips (staff)
  @Get('trips') @Roles('TRANSIT_OFFICER')
  listTrips(@Request() req: AuthRequest, @Query('status') status?: string) { return this.trips.listTrips(actor(req), { status: status || undefined }); }
  @Get('trips/:id') @Roles('TRANSIT_OFFICER', 'DRIVER')
  trip(@Param('id') id: string, @Request() req: AuthRequest) { return this.trips.tripDetail(id, actor(req)); }
  @Post('trips/:id/custody-exception') @Roles('ADMIN')
  custodyException(@Param('id') id: string, @Body('reason') reason: string, @Request() req: AuthRequest) { return this.trips.custodyException(id, actor(req), reason); }
}

@Controller('public/operations')
export class PublicOperationsController {
  constructor(private readonly service: OperationsService, private readonly collection: CollectionService) {}

  @Get('routes')
  routes() { return this.service.listRoutes(); }

  @Get('transit-points')
  transitPoints() { return this.service.listPublicTransitPoints(); }

  /** Locker kiosk for guests: the tracking number plus the emailed code completes collection (5 wrong codes lock it for 15 minutes). */
  @Post('lockers/collect')
  collectLocker(@Body() body: { trackingNumber: string; code: string }) { return this.collection.collectFromLockerByTracking(body?.trackingNumber, body?.code); }
}
