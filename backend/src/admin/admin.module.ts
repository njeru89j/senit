import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AuthModule } from '../auth/auth.module';
import { CommonModule } from '../common/common.module';
import { SendITMailerModule } from '../mailer/mailer.module';
import { PrismaService } from '../database/prisma.service';
import { OperationsModule } from '../operations/operations.module';

@Module({
  imports: [AuthModule, CommonModule, SendITMailerModule, OperationsModule],
  controllers: [AdminController],
  providers: [AdminService, PrismaService],
  exports: [AdminService],
})
export class AdminModule {}
