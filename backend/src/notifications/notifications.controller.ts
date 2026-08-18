import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Request,
  Body,
  UseGuards,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CreateNotificationDto, NotificationsQueryDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators';

interface AuthenticatedRequest {
  user: {
    sub: string;
    role: 'CUSTOMER' | 'DRIVER' | 'ADMIN';
  };
}

@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post()
  @Roles('ADMIN')
  async create(
    @Body() createNotificationDto: CreateNotificationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.notificationsService.create(createNotificationDto);
  }

  @Get()
  @Roles('CUSTOMER', 'DRIVER', 'ADMIN')
  async getUserNotifications(
    @Query() query: NotificationsQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return await this.notificationsService.getUserNotifications(
      req.user.sub,
      query,
    );
  }

  @Get('summary')
  @Roles('CUSTOMER', 'DRIVER', 'ADMIN')
  async getNotificationSummary(@Request() req: AuthenticatedRequest) {
    return this.notificationsService.getNotificationSummary(req.user.sub);
  }

  @Get(':id')
  @Roles('CUSTOMER', 'DRIVER', 'ADMIN')
  async findOne(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.notificationsService.findOne(id, req.user.sub);
  }

  @Patch(':id/read')
  @Roles('CUSTOMER', 'DRIVER', 'ADMIN')
  async markAsRead(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.notificationsService.markAsRead(id, req.user.sub);
  }

  @Patch('mark-all-read')
  @Roles('CUSTOMER', 'DRIVER', 'ADMIN')
  async markAllAsRead(@Request() req: AuthenticatedRequest) {
    return this.notificationsService.markAllAsRead(req.user.sub);
  }

  @Delete(':id')
  @Roles('CUSTOMER', 'DRIVER', 'ADMIN')
  async delete(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    await this.notificationsService.delete(id, req.user.sub);
    return { message: 'Notification deleted successfully' };
  }

  @Delete()
  @Roles('CUSTOMER', 'DRIVER', 'ADMIN')
  async deleteAll(@Request() req: AuthenticatedRequest) {
    return this.notificationsService.deleteAll(req.user.sub);
  }

}
