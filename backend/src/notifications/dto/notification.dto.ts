import {
  IsOptional,
  IsNumber,
  IsString,
  IsBoolean,
  IsDate,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { NotificationType } from '@prisma/client';

// Notification DTOs
export interface CreateNotificationDto {
  userId: string;
  title: string;
  message: string;
  type: NotificationType;
  actionUrl?: string;
  parcelId?: string;
}

export interface NotificationResponseDto {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: NotificationType;
  isRead: boolean;
  actionUrl?: string;
  parcelId?: string;
  createdAt: Date;
  readAt?: Date;
  parcel?: any; // ParcelResponseDto
}

export interface NotificationSummaryDto {
  totalNotifications: number;
  unreadCount: number;
  recentNotifications: NotificationResponseDto[];
  notificationsByType: Record<string, number>;
}

export class NotificationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  type?: NotificationType;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  isRead?: boolean;

  @IsOptional()
  @IsString()
  parcelId?: string;

  @IsOptional()
  @Type(() => Date)
  dateFrom?: Date;

  @IsOptional()
  @Type(() => Date)
  dateTo?: Date;

  @IsOptional()
  @IsString()
  sortBy?: 'createdAt' | 'type' | 'isRead';

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc';
}
