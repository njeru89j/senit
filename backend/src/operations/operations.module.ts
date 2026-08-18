import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../common/guards/roles.guard';
import { OperationsController, PublicOperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [OperationsController, PublicOperationsController],
  providers: [OperationsService, RolesGuard],
  exports: [OperationsService],
})
export class OperationsModule {}
