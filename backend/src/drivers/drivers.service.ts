import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ParcelStatus, Prisma } from '@prisma/client';
import {
  UpdateLocationDto,
  DriverApplicationResponseDto,
  UserResponseDto,
  AssignParcelDto,
  UpdateParcelStatusDto,
} from '../users/dto';
import { DriversGateway } from './drivers.gateway';
import { MailerService } from '../mailer/mailer.service';
import { assertParcelTransition } from '../common/parcel-lifecycle';

interface DriverPerformanceResponse {
  driverId: string;
  driverName: string;
  totalDeliveries: number;
  completedDeliveries: number;
  cancelledDeliveries: number;
  averageRating: number;
  totalRatings: number;
  totalEarnings: number;
  onTimeDeliveryRate: number;
  averageDeliveryTime: number;
  lastActiveAt: Date | null;
}

interface AssignParcelResponse {
  message: string;
  parcel: any; // This will be the Prisma Parcel type
  driver: UserResponseDto;
}

interface UpdateParcelStatusResponse {
  message: string;
  parcel: any; // This will be the Prisma Parcel type
}

@Injectable()
export class DriversService {
  private readonly logger = new Logger(DriversService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly driversGateway: DriversGateway,
    private readonly mailerService: MailerService,
  ) {}

  async findAll(query: {
    page?: number;
    limit?: number;
    search?: string;
    vehicleType?: 'MOTORCYCLE' | 'CAR' | 'VAN' | 'TRUCK';
    driverApplicationStatus?:
      | 'NOT_APPLIED'
      | 'PENDING'
      | 'APPROVED'
      | 'REJECTED';
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    minimumRating?: number;
    routeId?: string;
    isAvailable?: boolean;
  }): Promise<{
    drivers: UserResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 10,
      search,
      vehicleType,
      driverApplicationStatus,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      minimumRating,
      routeId,
      isAvailable,
    } = query;

    // Convert string parameters to proper types
    const pageNum = typeof page === 'string' ? parseInt(page, 10) : page;
    const limitNum = typeof limit === 'string' ? parseInt(limit, 10) : limit;
    const skip = (pageNum - 1) * limitNum;

    // Build where clause with proper typing
    const where: Prisma.UserWhereInput = {
      role: 'DRIVER',
      isActive: true,
      driverApplicationStatus: 'APPROVED',
      deletedAt: null,
    };

    if (isAvailable !== undefined) {
      where.isAvailable =
        typeof isAvailable === 'string'
          ? isAvailable === 'true'
          : isAvailable;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { licenseNumber: { contains: search, mode: 'insensitive' } },
        { vehicleNumber: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (vehicleType) {
      where.vehicleType = vehicleType;
    }

    if (driverApplicationStatus) {
      where.driverApplicationStatus = driverApplicationStatus;
    }

    if (minimumRating) {
      where.averageRating = {
        gte: minimumRating,
      };
    }

    let matchingProfiles: Array<{ userId: string; routesServed: string[]; currentRouteId: string | null }> | null = null;
    if (routeId) {
      matchingProfiles = await this.prisma.driverProfile.findMany({
        where: {
          OR: [
            { currentRouteId: routeId },
            { routesServed: { has: routeId } },
          ],
        },
        select: { userId: true, routesServed: true, currentRouteId: true },
      });
      where.id = { in: matchingProfiles.map((profile) => profile.userId) };
    }

    // Build order by clause
    const orderBy: Prisma.UserOrderByWithRelationInput = {};
    if (sortBy === 'averageRating') {
      orderBy.averageRating = sortOrder;
    } else if (sortBy === 'totalDeliveries') {
      orderBy.totalDeliveries = sortOrder;
    } else if (sortBy === 'name') {
      orderBy.name = sortOrder;
    } else if (sortBy === 'email') {
      orderBy.email = sortOrder;
    } else {
      orderBy.createdAt = sortOrder;
    }

    const [drivers, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limitNum,
        orderBy,
      }),
      this.prisma.user.count({ where }),
    ]);

    const profileByUserId = new Map(
      (matchingProfiles ?? await this.prisma.driverProfile.findMany({
        where: { userId: { in: drivers.map((driver) => driver.id) } },
        select: { userId: true, routesServed: true, currentRouteId: true },
      })).map((profile) => [profile.userId, profile]),
    );

    return {
      drivers: drivers.map((driver) => this.mapToDriverResponse(driver, profileByUserId.get(driver.id))),
      total,
      page: pageNum,
      limit: limitNum,
    };
  }

  async findOne(id: string): Promise<UserResponseDto> {
    const driver = await this.prisma.user.findFirst({
      where: {
        id,
        role: 'DRIVER',
        deletedAt: null,
      },
    });

    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    const driverProfile = await this.prisma.driverProfile.findUnique({
      where: { userId: id },
      select: { routesServed: true, currentRouteId: true },
    });

    return this.mapToDriverResponse(driver, driverProfile);
  }

  async updateLocation(
    id: string,
    updateLocationDto: UpdateLocationDto,
  ): Promise<UserResponseDto> {
    const { currentLat, currentLng } = updateLocationDto;

    // Check if driver exists
    const driver = await this.prisma.user.findFirst({
      where: {
        id,
        role: 'DRIVER',
        deletedAt: null,
      },
    });

    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    const updatedDriver = await this.prisma.user.update({
      where: { id },
      data: {
        currentLat,
        currentLng,
        lastActiveAt: new Date(),
      },
    });

    // Broadcast location update via WebSocket
    this.driversGateway.broadcastDriverLocation({
      driverId: updatedDriver.id,
      driverName: updatedDriver.name,
      currentLat: updatedDriver.currentLat!,
      currentLng: updatedDriver.currentLng!,
      lastActiveAt: updatedDriver.lastActiveAt!,
      vehicleType: updatedDriver.vehicleType || undefined,
      vehicleNumber: updatedDriver.vehicleNumber || undefined,
    });

    this.logger.log(`Driver ${id} location updated: ${currentLat}, ${currentLng}`);

    const driverProfile = await this.prisma.driverProfile.findUnique({
      where: { userId: id },
      select: { routesServed: true, currentRouteId: true },
    });

    return this.mapToDriverResponse(updatedDriver, driverProfile);
  }

  async approveDriverApplication(
    driverId: string,
    adminId: string,
  ): Promise<DriverApplicationResponseDto> {
    // Check if driver application exists
    const driver = await this.prisma.user.findFirst({
      where: {
        id: driverId,
        role: 'CUSTOMER',
        driverApplicationStatus: 'PENDING',
        deletedAt: null,
      },
    });

    if (!driver) {
      throw new NotFoundException('Driver application not found');
    }

    // Approve the application
    const updatedDriver = await this.prisma.user.update({
      where: { id: driverId },
      data: {
        role: 'DRIVER',
        driverApplicationStatus: 'APPROVED',
        driverApprovalDate: new Date(),
        driverApprovedBy: adminId,
        isAvailable: true,
      },
    });

    return this.mapToDriverApplicationResponse(updatedDriver);
  }

  async rejectDriverApplication(
    driverId: string,
    adminId: string,
    reason: string,
  ): Promise<DriverApplicationResponseDto> {
    // Check if driver application exists
    const driver = await this.prisma.user.findFirst({
      where: {
        id: driverId,
        role: 'CUSTOMER',
        driverApplicationStatus: 'PENDING',
        deletedAt: null,
      },
    });

    if (!driver) {
      throw new NotFoundException('Driver application not found');
    }

    // Reject the application
    const updatedDriver = await this.prisma.user.update({
      where: { id: driverId },
      data: {
        driverApplicationStatus: 'REJECTED',
        driverApprovalDate: new Date(),
        driverApprovedBy: adminId,
        driverRejectionReason: reason,
      },
    });

    return this.mapToDriverApplicationResponse(updatedDriver);
  }

  async getDriverPerformance(id: string): Promise<DriverPerformanceResponse> {
    const driver = await this.prisma.user.findFirst({
      where: {
        id,
        role: 'DRIVER',
        deletedAt: null,
      },
      include: {
        assignedParcels: {
          where: {
            status: {
              in: ['delivered', 'cancelled'],
            },
          },
        },
        reviewsReceived: true,
      },
    });

    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    const completedDeliveries = driver.assignedParcels.filter(
      (parcel) => parcel.status === 'delivered',
    ).length;
    const cancelledDeliveries = driver.assignedParcels.filter(
      (parcel) => parcel.status === 'cancelled',
    ).length;
    const totalDeliveries = driver.assignedParcels.length;

    const averageRating =
      driver.reviewsReceived.length > 0
        ? driver.reviewsReceived.reduce(
            (sum, review) => sum + review.rating,
            0,
          ) / driver.reviewsReceived.length
        : 0;

    return {
      driverId: driver.id,
      driverName: driver.name,
      totalDeliveries,
      completedDeliveries,
      cancelledDeliveries,
      averageRating,
      totalRatings: driver.reviewsReceived.length,
      totalEarnings: driver.totalEarnings || 0,
      onTimeDeliveryRate: driver.onTimeDeliveryRate || 0,
      averageDeliveryTime: driver.averageDeliveryTime || 0,
      lastActiveAt: driver.lastActiveAt,
    };
  }

  private mapToDriverResponse(
    driver: Prisma.UserGetPayload<Record<string, never>>,
    driverProfile?: { routesServed?: string[]; currentRouteId?: string | null } | null,
  ): UserResponseDto {
    return {
      id: driver.id,
      email: driver.email,
      name: driver.name,
      phone: driver.phone ?? undefined,
      address: driver.address ?? undefined,
      profilePicture: driver.profilePicture ?? undefined,
      role: driver.role,
      isActive: driver.isActive,
      licenseNumber: driver.licenseNumber ?? undefined,
      vehicleNumber: driver.vehicleNumber ?? undefined,
      vehicleType: driver.vehicleType ?? undefined,
      currentLat: driver.currentLat ?? undefined,
      currentLng: driver.currentLng ?? undefined,
      routesServed: driverProfile?.routesServed ?? [],
      currentRouteId: driverProfile?.currentRouteId ?? undefined,
      averageRating: driver.averageRating ?? undefined,
      totalRatings: driver.totalRatings,
      totalDeliveries: driver.totalDeliveries,
      completedDeliveries: driver.completedDeliveries,
      cancelledDeliveries: driver.cancelledDeliveries,
      averageDeliveryTime: driver.averageDeliveryTime ?? undefined,
      onTimeDeliveryRate: driver.onTimeDeliveryRate ?? undefined,
      lastActiveAt: driver.lastActiveAt ?? undefined,
      totalEarnings: driver.totalEarnings ?? undefined,
      totalParcelsEverSent: driver.totalParcelsEverSent,
      totalParcelsReceived: driver.totalParcelsReceived,
      preferredPaymentMethod: driver.preferredPaymentMethod ?? undefined,
      driverApplicationStatus: driver.driverApplicationStatus ?? undefined,
      driverApplicationDate: driver.driverApplicationDate ?? undefined,
      driverApplicationReason: driver.driverApplicationReason ?? undefined,
      driverApprovalDate: driver.driverApprovalDate ?? undefined,
      driverRejectionReason: driver.driverRejectionReason ?? undefined,
      createdAt: driver.createdAt,
      updatedAt: driver.updatedAt,
    };
  }

  private mapToDriverApplicationResponse(
    user: Record<string, any>,
  ): DriverApplicationResponseDto {
    return {
      id: user.id as string,
      email: user.email as string,
      name: user.name as string,
      driverApplicationStatus: user.driverApplicationStatus as
        | 'PENDING'
        | 'APPROVED'
        | 'REJECTED',
      driverApplicationDate: user.driverApplicationDate as Date,
      driverApplicationReason: user.driverApplicationReason as string,
      driverApprovalDate: user.driverApprovalDate as Date,
      driverRejectionReason: user.driverRejectionReason as string,
      licenseNumber: user.licenseNumber as string,
      vehicleNumber: user.vehicleNumber as string,
      vehicleType: user.vehicleType as
        | 'MOTORCYCLE'
        | 'CAR'
        | 'VAN'
        | 'TRUCK'
        | undefined,
    };
  }
}
