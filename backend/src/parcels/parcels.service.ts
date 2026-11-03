import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CustodyHolder, Prisma, Parcel, ParcelStatus, User, UserRole } from '@prisma/client';
import {
  CreateParcelDto,
  UpdateParcelDto,
  ParcelQueryDto,
  ParcelResponseDto,
  DeliveryConfirmationDto,
  MarkAsCompletedDto,
} from './dto';
import { UserResponseDto } from '../users/dto';
import { MailerService } from '../mailer/mailer.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DELIVERY_FEE_CONFIG } from '../common/constants';
import { createHmac, randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import { JourneyService } from '../operations/workflow/journey.service';
import { COLLECTION_METHODS, SMART_LOCKER, STATION_COLLECTION, lockerSizeFor } from '../operations/workflow/collection.service';

@Injectable()
export class ParcelsService {
  private readonly logger = new Logger(ParcelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailerService: MailerService,
    private readonly notificationsService: NotificationsService,
    private readonly journey: JourneyService,
  ) {}

  /** Active transit point or a clear error. */
  private async activePoint(id: string | undefined, label: string) {
    if (!id) throw new BadRequestException(`Select the ${label} transit point`);
    const point = await this.prisma.transitPoint.findFirst({ where: { id, active: true }, select: { id: true, name: true, latitude: true, longitude: true } });
    if (!point) throw new BadRequestException(`Selected ${label} transit point is not available`);
    return point;
  }

  /** Registered customer account for an email, used to link staff-booked parcels to their owners. */
  private async customerIdByEmail(email?: string | null): Promise<string | undefined> {
    if (!email?.trim()) return undefined;
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' }, role: 'CUSTOMER', deletedAt: null },
      select: { id: true },
    });
    return user?.id;
  }

  /** Parcels an officer may see: at, from, to, or passing through a leg at their stations. */
  private async getTransitOfficerParcelScope(
    officerId: string,
  ): Promise<Prisma.ParcelWhereInput> {
    const assignments = await this.prisma.transitPointOfficer.findMany({ where: { officerId }, select: { transitPointId: true } });
    const legacy = await this.prisma.transitPoint.findMany({ where: { officerId }, select: { id: true } });
    const pointIds = [...new Set([...assignments.map((item) => item.transitPointId), ...legacy.map((point) => point.id)])];
    if (!pointIds.length) return { id: { in: [] } };
    return {
      OR: [
        { currentTransitPointId: { in: pointIds } },
        { originTransitPointId: { in: pointIds } },
        { destinationTransitPointId: { in: pointIds } },
        { legs: { some: { OR: [{ fromTransitPointId: { in: pointIds } }, { toTransitPointId: { in: pointIds } }] } } },
      ],
    };
  }

  /** Parcels a driver may see: those they have (or had) an assignment for. */
  private driverParcelScope(driverId: string): Prisma.ParcelWhereInput {
    return { OR: [{ driverId }, { legs: { some: { assignments: { some: { driverId } } } } }] };
  }

  private addParcelScope(
    where: Prisma.ParcelWhereInput,
    scope: Prisma.ParcelWhereInput,
  ): void {
    where.AND = Array.isArray(where.AND) ? [...where.AND, scope] : where.AND ? [where.AND, scope] : [scope];
  }

  // Create parcel
  async create(
    createParcelDto: CreateParcelDto,
    userId?: string,
    userRole?: string,
  ): Promise<ParcelResponseDto> {
    let {
      senderName,
      senderEmail,
      senderPhone,
      recipientName,
      recipientEmail,
      recipientPhone,
      pickupTransitPointId,
      destinationTransitPointId,
      collectionMethod,
      requestLockerOnConfirmation,
      lockerRequestedMinutes,
      weight,
      category,
      description,
      value,
      deliveryInstructions,
    } = createParcelDto;

    if (userRole === 'TRANSIT_OFFICER' && userId) {
      // Over-the-counter bookings originate at the officer's own station.
      const assignment = await this.prisma.transitPointOfficer.findUnique({ where: { officerId: userId } });
      if (!assignment) throw new BadRequestException('Your account is not assigned to an active transit point');
      pickupTransitPointId = assignment.transitPointId;
    }
    const isStaff = userRole === 'ADMIN' || userRole === 'TRANSIT_OFFICER';
    const pickupTransitPoint = await this.activePoint(pickupTransitPointId, isStaff ? 'origin' : 'drop-off');
    const destinationTransitPoint = await this.activePoint(destinationTransitPointId, 'destination');
    // Route availability is validated now; the journey is frozen when the origin station confirms receipt.
    const journey = await this.journey.planPreview(pickupTransitPoint.id, destinationTransitPoint.id);
    const pickupAddress = pickupTransitPoint.name;
    const deliveryAddress = destinationTransitPoint.name;
    const journeySummary = journey.summary;
    const routeId = journey.legs[0].routeId;
    const method = collectionMethod ?? (requestLockerOnConfirmation ? SMART_LOCKER : STATION_COLLECTION);
    if (!(COLLECTION_METHODS as readonly string[]).includes(method)) throw new BadRequestException('Choose station collection or smart locker collection');

    if (userRole === 'CUSTOMER') {
      const customer = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, phone: true, isActive: true },
      });
      if (!customer || !customer.isActive) {
        throw new BadRequestException('Your customer account is not available');
      }
      if (!customer.phone) {
        throw new BadRequestException(
          'Add a phone number to your profile before creating a parcel',
        );
      }
      senderName = customer.name;
      senderEmail = customer.email;
      senderPhone = customer.phone;
    }

    if (!/^\d{10}$/.test(senderPhone)) {
      throw new BadRequestException('Sender phone number must contain exactly 10 digits');
    }
    if (!/^\d{10}$/.test(recipientPhone)) {
      throw new BadRequestException('Recipient phone number must contain exactly 10 digits');
    }

    // Generate unique tracking number
    const trackingNumber = await this.generateTrackingNumber();

    // Calculate delivery fee based on weight and distance
    const distanceKm = this.calculateTransitPointDistance(pickupTransitPoint, destinationTransitPoint);
    const deliveryFee = this.calculateDeliveryFee(weight, pickupAddress, deliveryAddress, undefined, value, distanceKm, category);

    // A customer books for themselves; staff book for a walk-in sender, who owns the parcel
    // (not the staff member) and is linked now if registered, or on signup otherwise.
    const senderId = userRole === 'CUSTOMER' ? userId : await this.customerIdByEmail(senderEmail);

    // Check if recipient is a registered user
    let recipientId: string | undefined = undefined;
    try {
      const recipientUser = await this.customerIdByEmail(recipientEmail);
      if (recipientUser) {
        recipientId = recipientUser;
        this.logger.log(`Recipient ${recipientEmail} is a registered user with ID: ${recipientId}`);
      } else {
        this.logger.log(`Recipient ${recipientEmail} is not a registered user`);
      }
    } catch (error) {
      this.logger.warn(`Failed to check if recipient is registered: ${error}`);
    }

    // Confirm the order and issue its security seal atomically.
    const sealIdentifier = `SEAL-${randomBytes(12).toString('hex')}`;
    const signedData = randomBytes(32).toString('hex');
    const { parcel, qrValue } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.parcel.create({
        data: {
        trackingNumber,
        qrSealIdentifier: sealIdentifier,
        senderId,
        recipientId: recipientId, // Set recipientId if recipient is registered
        senderName,
        senderEmail,
        senderPhone,
        recipientName,
        recipientEmail,
        recipientPhone,
        pickupAddress,
        deliveryAddress,
        routeId,
        originTransitPointId: pickupTransitPoint.id,
        destinationTransitPointId: destinationTransitPoint.id,
        deliveryMethod: method,
        weight,
        category,
        description,
        value,
        deliveryInstructions,
        deliveryFee,
        // Every parcel starts with the sender; the origin station confirms physical receipt
        // (staff bookings are confirmed straight after creation by the controller).
        status: ParcelStatus.awaiting_confirmation,
        custody: CustodyHolder.SENDER,
        currentTransitPointId: pickupTransitPoint.id,
        currentLocation: pickupAddress,
      },
        include: { sender: true, recipient: true, driver: true },
      });
      const signature = createHmac('sha256', signedData).update(`${created.id}:${sealIdentifier}`).digest('hex');
      const qrPayload = JSON.stringify({ type: 'SENDIT_SEAL', parcelId: created.id, identifier: sealIdentifier, signature });
      await tx.parcelSeal.create({ data: { parcelId: created.id, identifier: sealIdentifier, signedData, createdBy: userId ?? created.id } });
      await tx.parcelStatusHistory.create({
        data: {
          parcelId: created.id,
          status: created.status,
          location: pickupAddress,
          updatedBy: userId,
          notes: (isStaff
            ? `Parcel booked over the counter at ${pickupAddress} by ${userRole === 'ADMIN' ? 'an admin' : 'the transit officer'}.`
            : `Booked. Hand the parcel over at ${pickupAddress} within 24 hours.`)
            + ` Planned journey: ${journeySummary}. Collection: ${method === SMART_LOCKER ? 'smart locker' : 'station counter'}.`,
        },
      });
      const lockerRequester = recipientId ?? senderId ?? userId;
      if (method === SMART_LOCKER && lockerRequester) {
        const lockerSize = lockerSizeFor(weight);
        await tx.lockerRequest.create({ data: { parcelId: created.id, requestedBy: lockerRequester, size: lockerSize, requestedMinutes: Math.min(72 * 60, Math.max(60, Math.round(Number(lockerRequestedMinutes) || 1440))) } });
      }
      await tx.auditLog.create({ data: { userId, action: 'PARCEL_CREATED_WITH_SECURITY_SEAL', entityType: 'Parcel', entityId: created.id, after: { identifier: sealIdentifier, createdByRole: userRole, senderId: senderId ?? null } } });
      return { parcel: created, qrValue: qrPayload };
    });

    // Create notifications for both sender and recipient
    try {
      // Notification for sender (if registered)
      if (senderId) {
        await this.notificationsService.create({
          userId: senderId,
          title: 'Parcel Created',
          message: `Your parcel with tracking number ${trackingNumber} has been created successfully.`,
          type: 'PARCEL_CREATED',
          actionUrl: `/parcel/${parcel.id}`,
          parcelId: parcel.id,
        });
      }

      // Notification for recipient (if registered)
      if (parcel.recipientId) {
        await this.notificationsService.create({
          userId: parcel.recipientId,
          title: 'Parcel Created',
          message: `A parcel with tracking number ${trackingNumber} has been created for you.`,
          type: 'PARCEL_CREATED',
          actionUrl: `/parcel/${parcel.id}`,
          parcelId: parcel.id,
        });
      }
    } catch (notificationError) {
      this.logger.warn(
        'Failed to create parcel creation notifications:',
        notificationError,
      );
    }

    // Update user statistics for sender and recipient
    try {
      // Update sender statistics
      if (senderId) {
        await this.prisma.user.update({
          where: { id: senderId },
          data: {
            totalParcelsEverSent: {
              increment: 1,
            },
          },
        });
      }

      // Update recipient statistics
      if (parcel.recipientId) {
        await this.prisma.user.update({
          where: { id: parcel.recipientId },
          data: {
            totalParcelsReceived: {
              increment: 1,
            },
          },
        });
      }
    } catch (statsError) {
      this.logger.warn(
        'Failed to update user statistics:',
        statsError,
      );
    }

    return {
      ...this.mapToParcelResponse(parcel),
      securitySeal: { identifier: sealIdentifier, qrValue, qrDataUrl: await QRCode.toDataURL(qrValue, { errorCorrectionLevel: 'H', margin: 1, width: 360 }) },
    };
  }

  // Find all parcels with filtering
  async findAll(
    query: ParcelQueryDto,
    userId?: string,
    userRole?: string,
  ): Promise<{
    parcels: ParcelResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 10,
      search,
      status,
      dateFrom,
      dateTo,
      assignedToMe,
    } = query;

    // Convert string parameters to integers
    const pageNum = typeof page === 'string' ? parseInt(page, 10) : page;
    const limitNum = typeof limit === 'string' ? parseInt(limit, 10) : limit;
    const skip = (pageNum - 1) * limitNum;

    // Build where clause
    const where: Prisma.ParcelWhereInput = {
      deletedAt: null,
    };

    // Filter based on user role and permissions
    if (userRole === 'CUSTOMER' && userId) {
      // Get user details to check name and email
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true }
      });

      if (user) {
        where.OR = [
          { senderId: userId },
          { recipientId: userId },
          { senderId: null, senderEmail: { equals: user.email, mode: 'insensitive' } },
          { recipientId: null, recipientEmail: { equals: user.email, mode: 'insensitive' } },
        ];
      } else {
        // Fallback to just ID if user not found
        where.OR = [{ senderId: userId }, { recipientId: userId }];
      }
    } else if (userRole === 'DRIVER' && userId) {
      // Drivers only ever see parcels they have been assigned (assignedToMe is implied).
      void assignedToMe;
      this.addParcelScope(where, this.driverParcelScope(userId));
    } else if (userRole === 'TRANSIT_OFFICER' && userId) {
      this.addParcelScope(where, await this.getTransitOfficerParcelScope(userId));
    }

    // Apply search filter (combine with existing OR conditions)
    if (search) {
      const searchConditions = [
        { trackingNumber: { contains: search, mode: 'insensitive' as const } },
        { senderName: { contains: search, mode: 'insensitive' as const } },
        { recipientName: { contains: search, mode: 'insensitive' as const } },
        { pickupAddress: { contains: search, mode: 'insensitive' as const } },
        { deliveryAddress: { contains: search, mode: 'insensitive' as const } },
      ];

      if (where.OR) {
        // If there are existing OR conditions (from role filtering), combine them
        where.AND = [{ OR: where.OR }, { OR: searchConditions }];
        delete where.OR;
      } else {
        where.OR = searchConditions;
      }
    }

    if (status) {
      where.status = status;
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) {
        where.createdAt.gte = new Date(dateFrom);
      }
      if (dateTo) {
        where.createdAt.lte = new Date(dateTo);
      }
    }

    const [parcels, total] = await Promise.all([
      this.prisma.parcel.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
        include: {
          sender: true,
          recipient: true,
          driver: true,
          statusHistory: {
            orderBy: { timestamp: 'desc' },
            take: 1,
          },
        },
      }),
      this.prisma.parcel.count({ where }),
    ]);

    return {
      parcels: parcels.map((parcel) => (this.isStaff(userRole) ? this.mapToParcelResponse(parcel) : this.hideStaffDetail(this.mapToParcelResponse(parcel)))),
      total,
      page: pageNum,
      limit: limitNum,
    };
  }

  // Find parcel by ID
  async findOne(
    id: string,
    userId?: string,
    userRole?: string,
  ): Promise<ParcelResponseDto> {
    const where: Prisma.ParcelWhereInput = {
      id,
      deletedAt: null,
    };

    // Add role-based filtering
    if (userRole === 'CUSTOMER' && userId) {
      // Get user details to check name and email
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true }
      });

      if (user) {
        where.OR = [
          { senderId: userId },
          { recipientId: userId },
          // Unlinked parcels match by email only; display names are not unique.
          { senderId: null, senderEmail: { equals: user.email, mode: 'insensitive' } },
          { recipientId: null, recipientEmail: { equals: user.email, mode: 'insensitive' } },
        ];
      } else {
        // Fallback to just ID if user not found
        where.OR = [{ senderId: userId }, { recipientId: userId }];
      }
    } else if (userRole === 'DRIVER' && userId) {
      this.addParcelScope(where, this.driverParcelScope(userId));
    } else if (userRole === 'TRANSIT_OFFICER' && userId) {
      this.addParcelScope(where, await this.getTransitOfficerParcelScope(userId));
    }

    const parcel = await this.prisma.parcel.findFirst({
      where,
      include: {
        sender: true,
        recipient: true,
        driver: true,
        statusHistory: {
          orderBy: { timestamp: 'desc' },
        },
        reviews: {
          include: {
            reviewer: true,
            reviewee: true,
          },
        },
        deliveryProof: {
          include: {
            driver: true,
            recipient: true,
          },
        },
      },
    });

    if (!parcel) {
      throw new NotFoundException('Parcel not found');
    }

    return this.isStaff(userRole) ? this.mapToParcelResponse(parcel) : this.hideStaffDetail(this.mapToParcelResponse(parcel));
  }

  // Find parcel by tracking number
  async findByTrackingNumber(
    trackingNumber: string,
    userRole?: string,
  ): Promise<ParcelResponseDto> {
    const parcel = await this.prisma.parcel.findFirst({
      where: {
        trackingNumber,
        deletedAt: null,
      },
      include: {
        sender: true,
        recipient: true,
        driver: true,
        statusHistory: {
          orderBy: { timestamp: 'desc' },
        },
        reviews: {
          include: {
            reviewer: true,
            reviewee: true,
          },
        },
        deliveryProof: {
          include: {
            driver: true,
            recipient: true,
          },
        },
      },
    });

    if (!parcel) {
      throw new NotFoundException('Parcel not found');
    }

    return this.isStaff(userRole) ? this.mapToParcelResponse(parcel) : this.hideStaffDetail(this.mapToParcelResponse(parcel));
  }

  async findPublicTrackingByNumber(trackingNumber: string) {
    const parcel = await this.prisma.parcel.findFirst({
      where: { trackingNumber, deletedAt: null },
      select: {
        trackingNumber: true,
        status: true,
        pickupAddress: true,
        deliveryAddress: true,
        currentLocation: true,
        estimatedPickupTime: true,
        estimatedDeliveryTime: true,
        actualDeliveryTime: true,
        updatedAt: true,
        statusHistory: {
          orderBy: { timestamp: 'desc' },
          select: { status: true, location: true, timestamp: true },
        },
      },
    });
    if (!parcel) throw new NotFoundException('Parcel not found');
    // Public tracking shows where the parcel is and what has happened, not the internal journey plan.
    return parcel;
  }

  // Update parcel
  /**
   * The sender may change route-critical details (stations, weight, recipient, collection method) only
   * before the origin station confirms receipt; afterwards they are locked and corrections go through the
   * staff weight-correction and re-plan workflows. Descriptive fields stay editable.
   */
  async update(
    id: string,
    updateParcelDto: UpdateParcelDto,
    userId?: string,
    userRole?: string,
  ): Promise<ParcelResponseDto> {
    const existing = await this.findOne(id, userId, userRole);
    const parcel = await this.prisma.parcel.findUniqueOrThrow({ where: { id } });
    const { description, value, deliveryInstructions, notes, pickupTransitPointId, destinationTransitPointId, weight, collectionMethod, recipientName, recipientEmail, recipientPhone } = updateParcelDto;
    const routeCritical = [pickupTransitPointId, destinationTransitPointId, weight, collectionMethod, recipientName, recipientEmail, recipientPhone].some((field) => field !== undefined);
    if (['delivered', 'completed', 'cancelled', 'returned'].includes(existing.status)) throw new BadRequestException('A closed parcel cannot be edited');

    const data: Prisma.ParcelUncheckedUpdateInput = { description, value, deliveryInstructions, notes };
    if (routeCritical) {
      if (userRole !== 'CUSTOMER' || parcel.senderId !== userId) throw new ForbiddenException('Only the sender can change these details online. Staff use the weight correction or re-plan actions.');
      if (parcel.status !== ParcelStatus.awaiting_confirmation) throw new BadRequestException('The route, weight and recipient are locked once the origin station has received the parcel');
      const origin = await this.activePoint(pickupTransitPointId ?? parcel.originTransitPointId ?? parcel.currentTransitPointId ?? undefined, 'drop-off');
      const destination = await this.activePoint(destinationTransitPointId ?? parcel.destinationTransitPointId ?? undefined, 'destination');
      const plan = await this.journey.planPreview(origin.id, destination.id);
      const newWeight = weight ?? parcel.weight;
      if (!(newWeight > 0) || newWeight > 1000) throw new BadRequestException('Weight must be between 0 and 1000 kg');
      const method = collectionMethod ?? parcel.deliveryMethod;
      if (!(COLLECTION_METHODS as readonly string[]).includes(method)) throw new BadRequestException('Choose station collection or smart locker collection');
      if (recipientPhone !== undefined && !/^\d{10}$/.test(recipientPhone)) throw new BadRequestException('Recipient phone number must contain exactly 10 digits');
      const newRecipientEmail = recipientEmail ?? parcel.recipientEmail;
      Object.assign(data, {
        originTransitPointId: origin.id,
        destinationTransitPointId: destination.id,
        currentTransitPointId: origin.id,
        pickupAddress: origin.name,
        deliveryAddress: destination.name,
        currentLocation: origin.name,
        routeId: plan.legs[0].routeId,
        weight: newWeight,
        deliveryMethod: method,
        deliveryFee: this.calculateDeliveryFee(newWeight, origin.name, destination.name, undefined, value ?? parcel.value ?? undefined, this.calculateTransitPointDistance(origin, destination), parcel.category ?? undefined),
        recipientName: recipientName ?? parcel.recipientName,
        recipientEmail: newRecipientEmail,
        recipientPhone: recipientPhone ?? parcel.recipientPhone,
        recipientId: recipientEmail !== undefined ? (await this.customerIdByEmail(newRecipientEmail)) ?? null : parcel.recipientId,
      });
    }

    const updatedParcel = await this.prisma.$transaction(async (tx) => {
      const result = await tx.parcel.updateMany({ where: { id, ...(routeCritical ? { status: ParcelStatus.awaiting_confirmation } : {}) }, data: data as Prisma.ParcelUncheckedUpdateManyInput });
      if (!result.count) throw new BadRequestException('The parcel was received at the station before this change was saved; the route is now locked');
      if (routeCritical) {
        const method = (data.deliveryMethod as string) ?? parcel.deliveryMethod;
        if (method === SMART_LOCKER && !(await tx.lockerRequest.findFirst({ where: { parcelId: id, status: 'PENDING' } }))) {
          await tx.lockerRequest.create({ data: { parcelId: id, requestedBy: userId!, size: lockerSizeFor((data.weight as number) ?? parcel.weight) } });
        }
        if (method === STATION_COLLECTION) await tx.lockerRequest.updateMany({ where: { parcelId: id, status: 'PENDING' }, data: { status: 'REJECTED', reviewedAt: new Date() } });
        await tx.parcelStatusHistory.create({ data: { parcelId: id, status: parcel.status, updatedBy: userId, location: (data.pickupAddress as string) ?? parcel.pickupAddress, notes: 'Booking details updated by the sender before hand-over.' } });
        await tx.auditLog.create({
          data: {
            userId, action: 'PARCEL_BOOKING_UPDATED', entityType: 'Parcel', entityId: id,
            before: { origin: parcel.originTransitPointId, destination: parcel.destinationTransitPointId, weight: parcel.weight, method: parcel.deliveryMethod } as Prisma.InputJsonValue,
            after: { origin: data.originTransitPointId, destination: data.destinationTransitPointId, weight: data.weight, method: data.deliveryMethod } as Prisma.InputJsonValue,
          },
        });
      }
      return tx.parcel.findUniqueOrThrow({ where: { id }, include: { sender: true, recipient: true, driver: true, statusHistory: { orderBy: { timestamp: 'desc' } } } });
    });

    if (routeCritical) {
      this.journey.announceBookingChange(updatedParcel, [parcel.originTransitPointId, parcel.currentTransitPointId, parcel.destinationTransitPointId, updatedParcel.originTransitPointId, updatedParcel.destinationTransitPointId]);
    }
    return this.hideStaffDetail(this.mapToParcelResponse(updatedParcel));
  }

  // Confirm delivery (for recipients)
  async confirmDelivery(
    id: string,
    confirmationDto: DeliveryConfirmationDto,
    recipientId: string,
  ): Promise<ParcelResponseDto> {
    const { customerSignature, customerNotes } = confirmationDto;

    // Get the user's email to check if they are the recipient
    const user = await this.prisma.user.findUnique({
      where: { id: recipientId },
      select: { email: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Verify parcel is assigned to this recipient
    // Check both by recipientId and by recipientEmail
    const parcel = await this.prisma.parcel.findFirst({
      where: {
        id,
        OR: [
          { recipientId },
          { recipientEmail: user.email }
        ],
        status: 'delivered_to_recipient',
        deletedAt: null,
      },
    });

    if (!parcel) {
      throw new NotFoundException(
        'Parcel not found or not ready for confirmation',
      );
    }

    // Update parcel status
    const updatedParcel = await this.prisma.parcel.update({
      where: { id },
      data: {
        status: 'delivered',
        deliveryConfirmedAt: new Date(),
        deliveryConfirmedBy: recipientId,
        customerSignature,
        customerNotes,
      },
      include: {
        sender: true,
        recipient: true,
        driver: true,
        statusHistory: {
          orderBy: { timestamp: 'desc' },
        },
      },
    });

    // Create delivery proof
    await this.prisma.deliveryProof.create({
      data: {
        parcelId: id,
        customerSignature,
        recipientName: parcel.recipientName,
        deliveredAt: parcel.actualDeliveryTime || new Date(),
        confirmedAt: new Date(),
        deliveredBy: parcel.driverId!,
        confirmedBy: recipientId,
        customerNotes,
      },
    });

    // Create status history entry
    await this.prisma.parcelStatusHistory.create({
      data: {
        parcelId: id,
        status: 'delivered',
        location: parcel.currentLocation,
        latitude: parcel.latitude,
        longitude: parcel.longitude,
        updatedBy: recipientId,
        notes: 'Delivery confirmed by recipient',
      },
    });

    // Create notifications for both sender and recipient
    try {
      // Notification for sender (if registered)
      if (updatedParcel.senderId) {
        await this.notificationsService.create({
          userId: updatedParcel.senderId,
          title: 'Parcel Delivered',
          message: `Your parcel with tracking number ${updatedParcel.trackingNumber} has been delivered to the recipient.`,
          type: 'PARCEL_DELIVERED',
          actionUrl: `/parcel/${updatedParcel.id}`,
          parcelId: updatedParcel.id,
        });
      }

      // Notification for recipient (if registered)
      if (updatedParcel.recipientId) {
        await this.notificationsService.create({
          userId: updatedParcel.recipientId,
          title: 'Parcel Delivered',
          message: `Your parcel with tracking number ${updatedParcel.trackingNumber} has been delivered successfully.`,
          type: 'PARCEL_DELIVERED',
          actionUrl: `/parcel/${updatedParcel.id}`,
          parcelId: updatedParcel.id,
        });
      }
    } catch (notificationError) {
      this.logger.warn(
        'Failed to create delivery confirmation notifications:',
        notificationError,
      );
    }

    return this.mapToParcelResponse(updatedParcel);
  }

  // Cancel parcel
  async cancel(
    id: string,
    userId?: string,
    userRole?: string,
  ): Promise<ParcelResponseDto> {
    await this.findOne(id, userId, userRole);
    await this.journey.cancelParcel(id, { id: userId!, role: userRole as UserRole }, userRole === 'CUSTOMER' ? 'Cancelled by the sender before hand-over' : 'Cancelled by staff');
    const updatedParcel = await this.prisma.parcel.findUniqueOrThrow({ where: { id }, include: { sender: true, recipient: true, driver: true, statusHistory: { orderBy: { timestamp: 'desc' } } } });
    return this.isStaff(userRole) ? this.mapToParcelResponse(updatedParcel) : this.hideStaffDetail(this.mapToParcelResponse(updatedParcel));
  }

  // Mark parcel as completed (for customers)
  async markAsCompleted(
    id: string,
    markAsCompletedDto: MarkAsCompletedDto,
    userId: string,
  ): Promise<ParcelResponseDto> {
    const { customerNotes } = markAsCompletedDto;

    this.logger.log(`Attempting to mark parcel ${id} as completed by user ${userId}`);

    // Get the user's email to check if they are the recipient
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Verify parcel is assigned to this user (customer) and is in a state ready for completion
    // Check both by recipientId and by recipientEmail
    const parcel = await this.prisma.parcel.findFirst({
      where: {
        id,
        OR: [
          { recipientId: userId },
          { recipientEmail: user.email }
        ],
        status: {
          in: ['delivered_to_recipient', 'delivered']
        },
        deletedAt: null,
      },
    });

    if (!parcel) {
      // Let's check what the parcel status actually is
      const parcelCheck = await this.prisma.parcel.findFirst({
        where: {
          id,
          deletedAt: null,
        },
        select: {
          id: true,
          status: true,
          recipientId: true,
          recipientEmail: true,
          senderId: true,
        },
      });

      this.logger.error(`Parcel not found or not ready for completion. Parcel check:`, parcelCheck);
      this.logger.error(`User email: ${user.email}`);
      throw new NotFoundException(
        'Parcel not found or not ready for completion',
      );
    }

    this.logger.log(`Found parcel ${id} with status ${parcel.status}, proceeding with completion`);

    // Update parcel status
    const updatedParcel = await this.prisma.parcel.update({
      where: { id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        completedBy: userId,
        notes: customerNotes,
      },
      include: {
        sender: true,
        recipient: true,
        driver: true,
        statusHistory: {
          orderBy: { timestamp: 'desc' },
        },
      },
    });

    // Create status history entry
    await this.prisma.parcelStatusHistory.create({
      data: {
        parcelId: id,
        status: 'completed',
        location: updatedParcel.currentLocation,
        latitude: updatedParcel.latitude,
        longitude: updatedParcel.longitude,
        updatedBy: userId,
        notes: 'Parcel completed by customer',
      },
    });

    // Create notifications for both sender and recipient
    try {
      // Notification for sender (if registered)
      if (updatedParcel.senderId) {
        await this.notificationsService.create({
          userId: updatedParcel.senderId,
          title: 'Parcel Completed',
          message: `Your parcel with tracking number ${updatedParcel.trackingNumber} has been marked as completed by the recipient.`,
          type: 'PARCEL_COMPLETED',
          actionUrl: `/parcel/${updatedParcel.id}`,
          parcelId: updatedParcel.id,
        });
      }

      // Notification for recipient (if registered)
      if (updatedParcel.recipientId) {
        await this.notificationsService.create({
          userId: updatedParcel.recipientId,
          title: 'Parcel Completed',
          message: `Your parcel with tracking number ${updatedParcel.trackingNumber} has been marked as completed. You can now leave a review.`,
          type: 'PARCEL_COMPLETED',
          actionUrl: `/parcel/${updatedParcel.id}`,
          parcelId: updatedParcel.id,
        });
      }
    } catch (notificationError) {
      this.logger.warn(
        'Failed to create completion notifications:',
        notificationError,
      );
    }

    // Send completion emails to both sender and recipient
    try {
      const completedAt = new Date();
      
      // Email to sender
      if (updatedParcel.senderEmail) {
        this.logger.log(`Debug - Sender data for completion: name="${updatedParcel.senderName}", profilePicture="${updatedParcel.sender?.profilePicture}"`);
        this.logger.log(`Debug - Sender user object:`, JSON.stringify(updatedParcel.sender, null, 2));
        await this.mailerService.sendParcelCompletedEmail({
          to: updatedParcel.senderEmail,
          name: updatedParcel.senderName,
          profilePicture: updatedParcel.sender?.profilePicture || undefined,
          parcelId: updatedParcel.id,
          trackingNumber: updatedParcel.trackingNumber,
          completedAt: completedAt,
        });
      }

      // Email to recipient
      if (updatedParcel.recipientEmail) {
        this.logger.log(`Debug - Recipient data for completion: name="${updatedParcel.recipientName}", profilePicture="${updatedParcel.recipient?.profilePicture}"`);
        this.logger.log(`Debug - Recipient user object:`, JSON.stringify(updatedParcel.recipient, null, 2));
        await this.mailerService.sendParcelCompletedEmail({
          to: updatedParcel.recipientEmail,
          name: updatedParcel.recipientName,
          profilePicture: updatedParcel.recipient?.profilePicture || undefined,
          parcelId: updatedParcel.id,
          trackingNumber: updatedParcel.trackingNumber,
          completedAt: completedAt,
        });
      }
    } catch (emailError) {
      this.logger.warn(
        'Failed to send completion emails:',
        emailError,
      );
    }

    return this.mapToParcelResponse(updatedParcel);
  }

  // Get parcel status history
  async getStatusHistory(
    id: string,
    userId?: string,
    userRole?: string,
  ): Promise<any[]> {
    // Check if user has permission to view this parcel
    await this.findOne(id, userId, userRole);

    const statusHistory = await this.prisma.parcelStatusHistory.findMany({
      where: {
        parcelId: id,
      },
      orderBy: { timestamp: 'desc' },
      include: {
        updatedByUser: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
    });

    return statusHistory;
  }

  async getTrackingOverview(id: string, userId: string, userRole: string) {
    const parcel = await this.findOne(id, userId, userRole);
    const [history, locker, seal, scans, alerts] = await Promise.all([
      this.prisma.parcelStatusHistory.findMany({ where: { parcelId: id }, orderBy: { timestamp: 'asc' } }),
      this.prisma.lockerAssignment.findFirst({ where: { parcelId: id, cancelledAt: null }, orderBy: { assignedAt: 'desc' } }),
      this.prisma.parcelSeal.findUnique({ where: { parcelId: id } }),
      this.prisma.sealScan.findMany({ where: { parcelId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.tamperAlert.findMany({ where: { parcelId: id }, orderBy: { createdAt: 'asc' } }),
    ]);
    let lockerDetails: any = null;
    if (locker) {
      const compartment = await this.prisma.lockerCompartment.findUnique({ where: { id: locker.compartmentId } });
      const station = compartment ? await this.prisma.lockerStation.findUnique({ where: { id: compartment.stationId } }) : null;
      const collection = await this.prisma.collectionCode.findFirst({ where: { lockerAssignmentId: locker.id, usedAt: null }, orderBy: { createdAt: 'desc' } });
      lockerDetails = { id: locker.id, assignedAt: locker.assignedAt, placedAt: locker.placedAt, collectedAt: locker.collectedAt, compartmentNo: compartment?.compartmentNo, size: compartment?.size, stationName: station?.name, stationAddress: station?.address, expiresAt: collection?.expiresAt };
    }
    const staff = userRole === 'ADMIN' || userRole === 'TRANSIT_OFFICER';

    return {
      parcel: staff ? parcel : this.hideStaffDetail(parcel),
      // Operational notes name drivers and trips, so customers get the status, place and time only.
      timeline: staff ? history : history.map((entry) => ({ status: entry.status, location: entry.location, timestamp: entry.timestamp })),
      journey: staff ? await this.journey.journeyView(id, 'staff') : null,
      locker: lockerDetails,
      security: {
        seal: seal ? { identifier: seal.identifier, active: seal.active, createdAt: seal.createdAt } : null,
        scans: scans.map((scan) => ({ condition: scan.condition, transitPointId: scan.transitPointId, createdAt: scan.createdAt })),
        alerts: alerts.map((alert) => ({ type: alert.type, status: alert.status, createdAt: alert.createdAt, resolvedAt: alert.resolvedAt })),
      },
    };
  }

  // Get user's parcels (for customers)
  async getUserParcels(
    userId: string,
    type: 'sent' | 'received' = 'sent',
  ): Promise<ParcelResponseDto[]> {
    console.log(
      `🔍 Service - getUserParcels(userId: ${userId}, type: ${type})`,
    );

    // First, get the user details to check name and email
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true }
    });

    if (!user) {
      console.log(`❌ User not found: ${userId}`);
      return [];
    }

    console.log(`👤 User details:`, { name: user.name, email: user.email });

    const where: Prisma.ParcelWhereInput = {
      deletedAt: null,
    };

    if (type === 'sent') {
      where.OR = [
        { senderId: userId },
        { senderId: null, senderEmail: { equals: user.email, mode: 'insensitive' } },
      ];
      console.log(`📋 Sent query - checking senderId: ${userId}, senderName: ${user.name}, senderEmail: ${user.email}`);
    } else {
      where.OR = [
        { recipientId: userId },
        { recipientId: null, recipientEmail: { equals: user.email, mode: 'insensitive' } },
      ];
      console.log(`📋 Received query - checking recipientId: ${userId}, recipientName: ${user.name}, recipientEmail: ${user.email}`);
    }

    console.log(`📋 Final where clause:`, JSON.stringify(where, null, 2));

    const parcels = await this.prisma.parcel.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        sender: true,
        recipient: true,
        driver: true,
        statusHistory: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
      },
    });

    console.log(`📦 Database query result: ${parcels.length} parcels`);
    
    if (parcels.length > 0) {
      console.log(`📦 First parcel details:`, {
        id: parcels[0].id,
        trackingNumber: parcels[0].trackingNumber,
        senderId: parcels[0].senderId,
        recipientId: parcels[0].recipientId,
        senderName: parcels[0].senderName,
        recipientName: parcels[0].recipientName,
        status: parcels[0].status,
        createdAt: parcels[0].createdAt,
        updatedAt: parcels[0].updatedAt
      });
    } else {
      console.log(`📦 No parcels found for user ${userId} (type: ${type})`);
    }

    parcels.forEach((p, i) => {
      console.log(
        `  Parcel ${i + 1}: ${p.trackingNumber} (${p.senderName} → ${p.recipientName})`,
      );
      console.log(`    senderId: ${p.senderId}, recipientId: ${p.recipientId}`);
    });

    const result = parcels.map((parcel) => this.hideStaffDetail(this.mapToParcelResponse(parcel)));
    console.log(`✅ Returning ${result.length} parcels for ${type} query`);

    return result;
  }

  // Get driver's assigned parcels
  async getDriverParcels(
    driverId: string,
    status?: string,
  ): Promise<ParcelResponseDto[]> {
    const where: Prisma.ParcelWhereInput = {
      deletedAt: null,
      ...this.driverParcelScope(driverId),
    };

    if (status) {
      where.status = status as Prisma.EnumParcelStatusFilter;
    }

    const parcels = await this.prisma.parcel.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        sender: true,
        recipient: true,
        driver: true,
        statusHistory: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
        reviews: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    return parcels.map((parcel) => this.mapToParcelResponse(parcel));
  }

  /**
   * Links earlier parcels to a newly registered customer by email: parcels they sent (including walk-in
   * bookings recorded by staff before the ownership fix, which stored the staff member as sender) and
   * parcels addressed to them.
   */
  async linkAnonymousParcelsToUser(
    userId: string,
    userEmail: string,
  ): Promise<{
    linkedParcels: number;
    message: string;
  }> {
    try {
      const email = { equals: userEmail.trim(), mode: 'insensitive' as const };
      const staffRoles: Array<'ADMIN' | 'TRANSIT_OFFICER'> = ['ADMIN', 'TRANSIT_OFFICER'];
      const sent = await this.prisma.parcel.findMany({
        where: {
          senderEmail: email,
          OR: [{ senderId: null }, { sender: { role: { in: staffRoles }, NOT: { email } } }],
        },
        select: { id: true },
      });
      const received = await this.prisma.parcel.findMany({ where: { recipientId: null, recipientEmail: email }, select: { id: true } });
      if (!sent.length && !received.length) {
        return { linkedParcels: 0, message: 'No earlier parcels found for this email address.' };
      }
      await this.prisma.$transaction([
        this.prisma.parcel.updateMany({ where: { id: { in: sent.map((item) => item.id) } }, data: { senderId: userId } }),
        this.prisma.parcel.updateMany({ where: { id: { in: received.map((item) => item.id) } }, data: { recipientId: userId } }),
        this.prisma.lockerRequest.updateMany({ where: { parcelId: { in: received.map((item) => item.id) }, status: 'PENDING' }, data: { requestedBy: userId } }),
        this.prisma.user.update({ where: { id: userId }, data: { totalParcelsEverSent: { increment: sent.length }, totalParcelsReceived: { increment: received.length } } }),
      ]);
      const linked = new Set([...sent, ...received].map((item) => item.id)).size;
      this.logger.log(`Linked ${sent.length} sent and ${received.length} received parcels to user ${userId}`);
      return {
        linkedParcels: linked,
        message: `Successfully linked ${linked} previous parcels to your account.`,
      };
    } catch (error) {
      this.logger.error(
        `Failed to link anonymous parcels for user ${userId}:`,
        error,
      );
      return {
        linkedParcels: 0,
        message: 'Failed to link previous parcels to your account.',
      };
    }
  }

  // Enhanced method to link parcels to both sender and recipient
  async linkParcelToUsers(
    parcelId: string,
    senderId?: string,
    recipientId?: string,
  ): Promise<{
    success: boolean;
    message: string;
    updatedParcel?: any;
  }> {
    try {
      // Get the parcel first
      const parcel = await this.prisma.parcel.findUnique({
        where: { id: parcelId },
      });

      if (!parcel) {
        return {
          success: false,
          message: 'Parcel not found.',
        };
      }

      // Prepare update data
      const updateData: any = {};

      if (senderId) {
        updateData.senderId = senderId;
      }

      if (recipientId) {
        updateData.recipientId = recipientId;
      }

      // Update the parcel
      const updatedParcel = await this.prisma.parcel.update({
        where: { id: parcelId },
        data: updateData,
        include: {
          sender: true,
          recipient: true,
          driver: true,
        },
      });

      // Update user statistics if needed
      if (senderId) {
        await this.prisma.user.update({
          where: { id: senderId },
          data: {
            totalParcelsEverSent: {
              increment: 1,
            },
          },
        });
      }

      if (recipientId) {
        await this.prisma.user.update({
          where: { id: recipientId },
          data: {
            totalParcelsReceived: {
              increment: 1,
            },
          },
        });
      }

      this.logger.log(
        `Linked parcel ${parcelId} to sender: ${senderId}, recipient: ${recipientId}`,
      );

      return {
        success: true,
        message: 'Parcel successfully linked to users.',
        updatedParcel: this.mapToParcelResponse(updatedParcel),
      };
    } catch (error) {
      this.logger.error(`Failed to link parcel ${parcelId} to users:`, error);
      return {
        success: false,
        message: 'Failed to link parcel to users.',
      };
    }
  }

  // Link parcels by email matching (for bulk operations)
  async linkParcelsByEmail(
    userEmail: string,
    userId: string,
    linkType: 'sender' | 'recipient' | 'both' = 'both',
  ): Promise<{
    success: boolean;
    linkedParcels: number;
    message: string;
  }> {
    try {
      let whereCondition: any = {};
      let updateData: any = {};

      if (linkType === 'sender' || linkType === 'both') {
        whereCondition.senderEmail = userEmail;
        whereCondition.senderId = null;
        updateData.senderId = userId;
      }

      if (linkType === 'recipient' || linkType === 'both') {
        whereCondition.recipientEmail = userEmail;
        whereCondition.recipientId = null;
        updateData.recipientId = userId;
      }

      // Find parcels to link
      const parcelsToLink = await this.prisma.parcel.findMany({
        where: whereCondition,
      });

      if (parcelsToLink.length === 0) {
        return {
          success: true,
          linkedParcels: 0,
          message: 'No parcels found to link.',
        };
      }

      // Update parcels
      const updateResult = await this.prisma.parcel.updateMany({
        where: whereCondition,
        data: updateData,
      });

      // Update user statistics
      const senderParcels = parcelsToLink.filter(
        (p) => p.senderEmail === userEmail,
      ).length;
      const recipientParcels = parcelsToLink.filter(
        (p) => p.recipientEmail === userEmail,
      ).length;

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          totalParcelsEverSent: {
            increment: senderParcels,
          },
          totalParcelsReceived: {
            increment: recipientParcels,
          },
        },
      });

      this.logger.log(
        `Linked ${updateResult.count} parcels to user ${userId} (${userEmail})`,
      );

      return {
        success: true,
        linkedParcels: updateResult.count,
        message: `Successfully linked ${updateResult.count} parcels to your account.`,
      };
    } catch (error) {
      this.logger.error(
        `Failed to link parcels by email for user ${userId}:`,
        error,
      );
      return {
        success: false,
        linkedParcels: 0,
        message: 'Failed to link parcels to your account.',
      };
    }
  }

  // Get anonymous parcels by email (for checking before registration)
  async getAnonymousParcelsByEmail(
    email: string,
  ): Promise<ParcelResponseDto[]> {
    try {
      const parcels = await this.prisma.parcel.findMany({
        where: {
          senderId: null,
          senderEmail: email,
        },
        include: {
          recipient: true,
          driver: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      return parcels.map((parcel) => this.hideStaffDetail(this.mapToParcelResponse(parcel)));
    } catch (error) {
      this.logger.error(
        `Failed to get anonymous parcels for email ${email}:`,
        error,
      );
      return [];
    }
  }

  // Get autocomplete suggestions for names and emails
  async getAutocompleteSuggestions(
    query: string,
    type: 'name' | 'email' | 'phone',
    limit: number = 10,
  ): Promise<{
    users: Array<{ id: string; name: string; email: string; phone?: string }>;
    parcelHistory: Array<{
      name: string;
      email: string;
      phone: string;
      type: 'sender' | 'recipient';
    }>;
  }> {
    try {
      const searchQuery = query.toLowerCase();

      // Get suggestions from registered users
      const users = await this.prisma.user.findMany({
        where: {
          OR: [
            { name: { contains: searchQuery, mode: 'insensitive' } },
            { email: { contains: searchQuery, mode: 'insensitive' } },
          ],
          isActive: true,
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
        take: limit,
        orderBy: {
          name: 'asc',
        },
      });

      // Get suggestions from parcel history (both senders and recipients)
      const parcelHistory = await this.prisma.parcel.findMany({
        where: {
          OR: [
            { senderName: { contains: searchQuery, mode: 'insensitive' } },
            { senderEmail: { contains: searchQuery, mode: 'insensitive' } },
            { recipientName: { contains: searchQuery, mode: 'insensitive' } },
            { recipientEmail: { contains: searchQuery, mode: 'insensitive' } },
          ],
          deletedAt: null,
        },
        select: {
          senderName: true,
          senderEmail: true,
          senderPhone: true,
          recipientName: true,
          recipientEmail: true,
          recipientPhone: true,
        },
        take: limit * 2, // Get more to account for duplicates
        orderBy: {
          createdAt: 'desc',
        },
      });

      // Process parcel history to remove duplicates and format
      const parcelSuggestions = new Map<
        string,
        {
          name: string;
          email: string;
          phone: string;
          type: 'sender' | 'recipient';
        }
      >();

      parcelHistory.forEach((parcel) => {
        // Add sender suggestions
        const senderKey = `${parcel.senderEmail}-sender`;
        if (!parcelSuggestions.has(senderKey)) {
          parcelSuggestions.set(senderKey, {
            name: parcel.senderName,
            email: parcel.senderEmail,
            phone: parcel.senderPhone,
            type: 'sender',
          });
        }

        // Add recipient suggestions
        const recipientKey = `${parcel.recipientEmail}-recipient`;
        if (!parcelSuggestions.has(recipientKey)) {
          parcelSuggestions.set(recipientKey, {
            name: parcel.recipientName,
            email: parcel.recipientEmail,
            phone: parcel.recipientPhone,
            type: 'recipient',
          });
        }
      });

      // Convert to array and limit results
      const parcelHistoryArray = Array.from(parcelSuggestions.values()).slice(
        0,
        limit,
      );

      // Map users to expected format, handling null phone values
      const mappedUsers = users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone || undefined,
      }));

      return {
        users: mappedUsers,
        parcelHistory: parcelHistoryArray,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get autocomplete suggestions for query "${query}":`,
        error,
      );
      return {
        users: [],
        parcelHistory: [],
      };
    }
  }

  // Get specific suggestions for sender or recipient
  async getContactSuggestions(
    query: string,
    contactType: 'sender' | 'recipient',
    limit: number = 10,
    excludeRoles: ('CUSTOMER' | 'DRIVER' | 'ADMIN')[] = ['DRIVER', 'ADMIN'],
  ): Promise<
    Array<{
      name: string;
      email: string;
      phone: string;
      isRegistered: boolean;
      userId?: string;
    }>
  > {
    try {
      const searchQuery = query.toLowerCase();
      const suggestions = new Map<
        string,
        {
          name: string;
          email: string;
          phone: string;
          isRegistered: boolean;
          userId?: string;
        }
      >();

      // Get from registered users (excluding specified roles)
      const users = await this.prisma.user.findMany({
        where: {
          OR: [
            { name: { contains: searchQuery, mode: 'insensitive' } },
            { email: { contains: searchQuery, mode: 'insensitive' } },
          ],
          isActive: true,
          deletedAt: null,
          role: {
            notIn: excludeRoles,
          },
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
        take: limit,
      });

      users.forEach((user) => {
        suggestions.set(user.email, {
          name: user.name,
          email: user.email,
          phone: user.phone || '',
          isRegistered: true,
          userId: user.id,
        });
      });

      // Get from parcel history
      const parcelField = contactType === 'sender' ? 'sender' : 'recipient';
      const parcels = await this.prisma.parcel.findMany({
        where: {
          OR: [
            {
              [`${parcelField}Name`]: {
                contains: searchQuery,
                mode: 'insensitive',
              },
            },
            {
              [`${parcelField}Email`]: {
                contains: searchQuery,
                mode: 'insensitive',
              },
            },
          ],
          deletedAt: null,
        },
        select: {
          [`${parcelField}Name`]: true,
          [`${parcelField}Email`]: true,
          [`${parcelField}Phone`]: true,
        },
        take: limit * 2,
        orderBy: {
          createdAt: 'desc',
        },
      });

      parcels.forEach((parcel: any) => {
        const email = parcel[`${parcelField}Email`];
        if (!suggestions.has(email)) {
          suggestions.set(email, {
            name: parcel[`${parcelField}Name`],
            email: email,
            phone: parcel[`${parcelField}Phone`],
            isRegistered: false,
          });
        }
      });

      return Array.from(suggestions.values()).slice(0, limit);
    } catch (error) {
      this.logger.error(
        `Failed to get contact suggestions for ${contactType}:`,
        error,
      );
      return [];
    }
  }

  // Helper methods
  private async generateTrackingNumber(): Promise<string> {
    const prefix = 'SENDIT';
    const timestamp = Date.now().toString().slice(-8);
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();

    const trackingNumber = `${prefix}${timestamp}${random}`;

    // Check if tracking number already exists
    const existing = await this.prisma.parcel.findUnique({
      where: { trackingNumber },
    });

    if (existing) {
      // Recursively generate a new one if collision
      return this.generateTrackingNumber();
    }

    return trackingNumber;
  }

  // Helper method to map parcel status to notification type
  private mapStatusToNotificationType(status: string):
    | 'PARCEL_CREATED'
    | 'PARCEL_ASSIGNED'
    | 'PARCEL_PICKED_UP'
    | 'PARCEL_IN_TRANSIT'
    | 'PARCEL_DELIVERED_TO_RECIPIENT'
    | 'PARCEL_DELIVERED'
    | 'PARCEL_COMPLETED' {
    const statusMap: Record<string, any> = {
      'pending': 'PARCEL_CREATED',
      'assigned': 'PARCEL_ASSIGNED',
      'picked_up': 'PARCEL_PICKED_UP',
      'in_transit': 'PARCEL_IN_TRANSIT',
      'delivered_to_recipient': 'PARCEL_DELIVERED_TO_RECIPIENT',
      'delivered': 'PARCEL_DELIVERED',
      'completed': 'PARCEL_COMPLETED',
    };

    return statusMap[status] || 'PARCEL_CREATED';
  }

  /**
   * Customers and the public never see who is carrying their parcel: the driver is staff information.
   * Station names, status and timings stay visible.
   */
  private hideStaffDetail<T extends ParcelResponseDto>(parcel: T): T {
    return { ...parcel, driver: undefined, driverId: undefined, assignedAt: undefined };
  }

  private isStaff(userRole?: string): boolean {
    return userRole === 'ADMIN' || userRole === 'TRANSIT_OFFICER' || userRole === 'DRIVER';
  }

  private mapToParcelResponse(
    parcel: Parcel & {
      sender?: User | null;
      recipient?: User | null;
      driver?: User | null;
      statusHistory?: unknown[];
      reviews?: unknown[];
      deliveryProof?: unknown;
    },
  ): ParcelResponseDto {
    return {
      id: parcel.id,
      trackingNumber: parcel.trackingNumber,
      senderId: parcel.senderId || undefined,
      senderName: parcel.senderName,
      senderEmail: parcel.senderEmail,
      senderPhone: parcel.senderPhone,
      recipientId: parcel.recipientId || undefined,
      recipientName: parcel.recipientName,
      recipientEmail: parcel.recipientEmail,
      recipientPhone: parcel.recipientPhone,
      driverId: parcel.driverId || undefined,
      assignedAt: parcel.assignedAt || undefined,
      routeId: parcel.routeId || undefined,
      originTransitPointId: parcel.originTransitPointId || undefined,
      destinationTransitPointId: parcel.destinationTransitPointId || undefined,
      currentTransitPointId: parcel.currentTransitPointId || undefined,
      custody: parcel.custody,
      deliveryMethod: parcel.deliveryMethod,
      originConfirmedAt: parcel.originConfirmedAt || undefined,
      readyForCollectionAt: parcel.readyForCollectionAt || undefined,
      collectionDeadlineAt: parcel.collectionDeadlineAt || undefined,
      pickupAddress: parcel.pickupAddress,
      deliveryAddress: parcel.deliveryAddress,
      currentLocation: parcel.currentLocation || undefined,
      status: parcel.status,
      weight: parcel.weight,
      description: parcel.description || undefined,
      value: parcel.value || undefined,
      deliveryInstructions: parcel.deliveryInstructions || undefined,
      notes: parcel.notes || undefined,
      latitude: parcel.latitude || undefined,
      longitude: parcel.longitude || undefined,
      estimatedPickupTime: parcel.estimatedPickupTime || undefined,
      actualPickupTime: parcel.actualPickupTime || undefined,
      estimatedDeliveryTime: parcel.estimatedDeliveryTime || undefined,
      actualDeliveryTime: parcel.actualDeliveryTime || undefined,
      totalDeliveryTime: parcel.totalDeliveryTime || undefined,
      deliveryAttempts: parcel.deliveryAttempts,
      deliveryFee: parcel.deliveryFee || undefined,
      paymentStatus: parcel.paymentStatus,
      deliveredToRecipient: parcel.deliveredToRecipient,
      deliveryConfirmedAt: parcel.deliveryConfirmedAt || undefined,
      deliveryConfirmedBy: parcel.deliveryConfirmedBy || undefined,
      customerSignature: parcel.customerSignature || undefined,
      customerNotes: parcel.customerNotes || undefined,
      createdAt: parcel.createdAt,
      updatedAt: parcel.updatedAt,
      sender: parcel.sender ? this.mapToUserResponse(parcel.sender) : undefined,
      recipient: parcel.recipient
        ? this.mapToUserResponse(parcel.recipient)
        : undefined,
      driver: parcel.driver ? this.mapToUserResponse(parcel.driver) : undefined,
      statusHistory: parcel.statusHistory || [],
      reviews: parcel.reviews || [],
      deliveryProof: parcel.deliveryProof || null,
    };
  }

  private mapToUserResponse(user: User): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone || undefined,
      address: user.address || undefined,
      profilePicture: user.profilePicture || undefined,
      role: user.role,
      isActive: user.isActive,
      licenseNumber: user.licenseNumber || undefined,
      vehicleNumber: user.vehicleNumber || undefined,
      vehicleType: user.vehicleType || undefined,
      currentLat: user.currentLat || undefined,
      currentLng: user.currentLng || undefined,
      averageRating: user.averageRating || undefined,
      totalRatings: user.totalRatings,
      totalDeliveries: user.totalDeliveries,
      completedDeliveries: user.completedDeliveries,
      cancelledDeliveries: user.cancelledDeliveries,
      averageDeliveryTime: user.averageDeliveryTime || undefined,
      onTimeDeliveryRate: user.onTimeDeliveryRate || undefined,
      lastActiveAt: user.lastActiveAt || undefined,
      totalEarnings: user.totalEarnings || undefined,
      totalParcelsEverSent: user.totalParcelsEverSent,
      totalParcelsReceived: user.totalParcelsReceived,
      preferredPaymentMethod: user.preferredPaymentMethod || undefined,
      driverApplicationStatus: user.driverApplicationStatus || undefined,
      driverApplicationDate: user.driverApplicationDate || undefined,
      driverApprovalDate: user.driverApprovalDate || undefined,
      driverRejectionReason: user.driverRejectionReason || undefined,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * Parcels below 5 kg with a declared value below KSH 5,000 cost KSH 300.
   * All other parcels cost KSH 300 plus their weight at KSH 20/kg, increasing
   * by KSH 5/kg for every completed 100 km of the trip.
   * @param weight - Parcel weight in kg
   * @param pickupAddress - Pickup address
   * @param deliveryAddress - Delivery address
   * @returns Calculated delivery fee in KSH
   */
  public calculateDeliveryFee(
    weight: number,
    pickupAddress: string,
    deliveryAddress: string,
    _pricePerKg?: number,
    declaredValue: number = 0,
    distanceKm: number = 0,
    category?: string,
  ): number {
    const parcelWeight = Math.max(0, Number(weight) || 0);
    const parcelValue = Math.max(0, Number(declaredValue) || 0);

    const premiumCategory = ['FRAGILE', 'ELECTRONICS'].includes((category ?? '').trim().toUpperCase());
    if (premiumCategory) {
      return Math.max(500, Math.round(DELIVERY_FEE_CONFIG.MINIMUM_FEE + parcelWeight * (DELIVERY_FEE_CONFIG.BASE_PER_KG_FEE + Math.floor(Math.max(0, Number(distanceKm) || 0) / DELIVERY_FEE_CONFIG.DISTANCE_BAND_KM) * DELIVERY_FEE_CONFIG.DISTANCE_BAND_PER_KG_INCREASE)));
    }

    if (
      parcelWeight < DELIVERY_FEE_CONFIG.LIGHT_WEIGHT_LIMIT_KG &&
      parcelValue < DELIVERY_FEE_CONFIG.LOW_DECLARED_VALUE_LIMIT
    ) {
      return DELIVERY_FEE_CONFIG.MINIMUM_FEE;
    }

    const distanceBands = Math.floor(Math.max(0, Number(distanceKm) || 0) / DELIVERY_FEE_CONFIG.DISTANCE_BAND_KM);
    const perKgFee = DELIVERY_FEE_CONFIG.BASE_PER_KG_FEE
      + distanceBands * DELIVERY_FEE_CONFIG.DISTANCE_BAND_PER_KG_INCREASE;
    return Math.round(DELIVERY_FEE_CONFIG.MINIMUM_FEE + parcelWeight * perKgFee);
  }

  private calculateTransitPointDistance(
    pickup: { latitude: number | null; longitude: number | null } | null,
    destination: { latitude: number | null; longitude: number | null } | null,
  ): number {
    if (pickup?.latitude == null || pickup?.longitude == null || destination?.latitude == null || destination?.longitude == null) {
      return 0;
    }
    const toRadians = (degrees: number) => degrees * Math.PI / 180;
    const latitudeDifference = toRadians(destination.latitude - pickup.latitude);
    const longitudeDifference = toRadians(destination.longitude - pickup.longitude);
    const a = Math.sin(latitudeDifference / 2) ** 2
      + Math.cos(toRadians(pickup.latitude)) * Math.cos(toRadians(destination.latitude))
      * Math.sin(longitudeDifference / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
