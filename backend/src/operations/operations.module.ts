import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../common/guards/roles.guard';
import { OperationsController, PublicOperationsController, WorkflowController } from './operations.controller';
import { OperationsService } from './operations.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { SendITMailerModule } from '../mailer/mailer.module';
import { DriversModule } from '../drivers/drivers.module';
import { WorkflowContext } from './workflow/workflow-context.service';
import { DispatchService } from './workflow/dispatch.service';
import { CollectionService } from './workflow/collection.service';
import { JourneyService } from './workflow/journey.service';
import { TripsService } from './workflow/trips.service';
import { VerificationService } from './workflow/verification.service';
import { StationQueuesService } from './workflow/station-queues.service';
import { WorkflowSweepsService } from './workflow/workflow-sweeps.service';

@Module({
  // AuthModule → ParcelsModule → OperationsModule → AuthModule is a module-level cycle only.
  imports: [forwardRef(() => AuthModule), NotificationsModule, SendITMailerModule, DriversModule],
  controllers: [OperationsController, WorkflowController, PublicOperationsController],
  providers: [
    WorkflowContext, DispatchService, CollectionService, JourneyService, TripsService, VerificationService, StationQueuesService, WorkflowSweepsService,
    OperationsService, RolesGuard,
  ],
  exports: [OperationsService, JourneyService, DispatchService, CollectionService, TripsService, WorkflowContext],
})
export class OperationsModule {}
