-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ASSIGNED', 'ACKNOWLEDGED', 'COLLECTED', 'COMPLETED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('CREATED', 'IN_TRANSIT', 'SPLIT', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "LockerSize" AS ENUM ('SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE');

-- CreateEnum
CREATE TYPE "LockerStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'OCCUPIED', 'OUT_OF_SERVICE', 'AWAITING_COLLECTION', 'COLLECTION_COMPLETED');

-- CreateEnum
CREATE TYPE "SealCondition" AS ENUM ('INTACT', 'DAMAGED', 'BROKEN', 'QR_MISMATCH');

-- CreateEnum
CREATE TYPE "TamperAlertType" AS ENUM ('SEAL_DAMAGED', 'SEAL_BROKEN', 'QR_MISMATCH', 'DUPLICATE_QR', 'SKIPPED_TRANSIT_POINT', 'INVALID_SEQUENCE', 'UNAUTHORISED_SCAN');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'UNDER_INVESTIGATION', 'RESOLVED', 'ESCALATED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ParcelStatus" ADD VALUE 'created';
ALTER TYPE "ParcelStatus" ADD VALUE 'awaiting_confirmation';
ALTER TYPE "ParcelStatus" ADD VALUE 'awaiting_driver_assignment';
ALTER TYPE "ParcelStatus" ADD VALUE 'awaiting_pickup';
ALTER TYPE "ParcelStatus" ADD VALUE 'collected';
ALTER TYPE "ParcelStatus" ADD VALUE 'at_origin_transit_point';
ALTER TYPE "ParcelStatus" ADD VALUE 'arrived_at_transit_point';
ALTER TYPE "ParcelStatus" ADD VALUE 'at_transit_point';
ALTER TYPE "ParcelStatus" ADD VALUE 'at_destination';
ALTER TYPE "ParcelStatus" ADD VALUE 'batch_transferred';
ALTER TYPE "ParcelStatus" ADD VALUE 'out_for_delivery';
ALTER TYPE "ParcelStatus" ADD VALUE 'locker_assigned';
ALTER TYPE "ParcelStatus" ADD VALUE 'ready_for_locker_collection';
ALTER TYPE "ParcelStatus" ADD VALUE 'in_locker';
ALTER TYPE "ParcelStatus" ADD VALUE 'collected_from_locker';
ALTER TYPE "ParcelStatus" ADD VALUE 'delivery_unsuccessful';
ALTER TYPE "ParcelStatus" ADD VALUE 'returned';
ALTER TYPE "ParcelStatus" ADD VALUE 'tampering_alert';

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'TRANSIT_OFFICER';

-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "category" TEXT,
ADD COLUMN     "currentTransitPointId" TEXT,
ADD COLUMN     "deliveryMethod" TEXT,
ADD COLUMN     "dimensions" TEXT,
ADD COLUMN     "isFragile" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parcelNumber" TEXT,
ADD COLUMN     "preferredPickupAt" TIMESTAMP(3),
ADD COLUMN     "qrSealIdentifier" TEXT,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "routeId" TEXT;

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nationalId" TEXT,
    "routesServed" TEXT[],
    "currentRouteId" TEXT,
    "approvalStatus" "DriverStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "activationNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_documents" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publicId" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parcel_assignments" (
    "id" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "assignedBy" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,

    CONSTRAINT "parcel_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transit_points" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "contact" TEXT,
    "routeId" TEXT,
    "officerId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transit_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_transit_points" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "transitPointId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "instructions" TEXT,

    CONSTRAINT "route_transit_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batches" (
    "id" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "driverId" TEXT,
    "parentBatchId" TEXT,
    "status" "BatchStatus" NOT NULL DEFAULT 'CREATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_parcels" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loadedAt" TIMESTAMP(3),
    "loadedBy" TEXT,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "batch_parcels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_events" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "transitPointId" TEXT,
    "type" TEXT NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transit_inspections" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "transitPointId" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "condition" "SealCondition" NOT NULL,
    "decision" TEXT NOT NULL,
    "notes" TEXT,
    "inspectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transit_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locker_stations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "transitPointId" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "openingHours" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locker_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locker_compartments" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "compartmentNo" TEXT NOT NULL,
    "size" "LockerSize" NOT NULL,
    "status" "LockerStatus" NOT NULL DEFAULT 'AVAILABLE',
    "currentParcelId" TEXT,
    "lastMaintenance" TIMESTAMP(3),

    CONSTRAINT "locker_compartments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locker_assignments" (
    "id" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "compartmentId" TEXT NOT NULL,
    "assignedBy" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "locker_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locker_requests" (
    "id" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "stationId" TEXT,
    "size" "LockerSize" NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locker_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_codes" (
    "id" TEXT NOT NULL,
    "lockerAssignmentId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parcel_seals" (
    "id" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "signedData" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parcel_seals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seal_scans" (
    "id" TEXT NOT NULL,
    "sealId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "scannedBy" TEXT NOT NULL,
    "scannerRole" "UserRole" NOT NULL,
    "transitPointId" TEXT,
    "condition" "SealCondition" NOT NULL,
    "imageUrl" TEXT,
    "comments" TEXT,
    "previousStatus" "ParcelStatus",
    "currentStatus" "ParcelStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seal_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tamper_alerts" (
    "id" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "sealScanId" TEXT,
    "type" "TamperAlertType" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "details" TEXT NOT NULL,
    "investigation" TEXT,
    "outcome" TEXT,
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "tamper_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demand_forecasts" (
    "id" TEXT NOT NULL,
    "routeId" TEXT,
    "destination" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "predictedVolume" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION,
    "recommendedCapacity" INTEGER,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demand_forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecast_metrics" (
    "id" TEXT NOT NULL,
    "forecastId" TEXT NOT NULL,
    "actual" DOUBLE PRECISION NOT NULL,
    "error" DOUBLE PRECISION NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forecast_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_userId_key" ON "customer_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_userId_key" ON "driver_profiles"("userId");

-- CreateIndex
CREATE INDEX "driver_profiles_currentRouteId_idx" ON "driver_profiles"("currentRouteId");

-- CreateIndex
CREATE INDEX "driver_documents_driverId_idx" ON "driver_documents"("driverId");

-- CreateIndex
CREATE INDEX "parcel_assignments_parcelId_idx" ON "parcel_assignments"("parcelId");

-- CreateIndex
CREATE INDEX "parcel_assignments_driverId_status_idx" ON "parcel_assignments"("driverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "routes_name_key" ON "routes"("name");

-- CreateIndex
CREATE INDEX "transit_points_name_idx" ON "transit_points"("name");

-- CreateIndex
CREATE INDEX "transit_points_routeId_idx" ON "transit_points"("routeId");

-- CreateIndex
CREATE INDEX "transit_points_officerId_idx" ON "transit_points"("officerId");

-- CreateIndex
CREATE UNIQUE INDEX "route_transit_points_routeId_transitPointId_key" ON "route_transit_points"("routeId", "transitPointId");

-- CreateIndex
CREATE UNIQUE INDEX "route_transit_points_routeId_sequence_key" ON "route_transit_points"("routeId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "batches_batchNumber_key" ON "batches"("batchNumber");

-- CreateIndex
CREATE INDEX "batches_routeId_idx" ON "batches"("routeId");

-- CreateIndex
CREATE INDEX "batches_parentBatchId_idx" ON "batches"("parentBatchId");

-- CreateIndex
CREATE INDEX "batch_parcels_parcelId_idx" ON "batch_parcels"("parcelId");

-- CreateIndex
CREATE UNIQUE INDEX "batch_parcels_batchId_parcelId_key" ON "batch_parcels"("batchId", "parcelId");

-- CreateIndex
CREATE INDEX "batch_events_batchId_createdAt_idx" ON "batch_events"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "transit_inspections_batchId_inspectedAt_idx" ON "transit_inspections"("batchId", "inspectedAt");

-- CreateIndex
CREATE INDEX "transit_inspections_parcelId_inspectedAt_idx" ON "transit_inspections"("parcelId", "inspectedAt");

-- CreateIndex
CREATE INDEX "transit_inspections_transitPointId_officerId_idx" ON "transit_inspections"("transitPointId", "officerId");

-- CreateIndex
CREATE UNIQUE INDEX "locker_stations_name_key" ON "locker_stations"("name");

-- CreateIndex
CREATE INDEX "locker_stations_transitPointId_idx" ON "locker_stations"("transitPointId");

-- CreateIndex
CREATE INDEX "locker_compartments_stationId_status_size_idx" ON "locker_compartments"("stationId", "status", "size");

-- CreateIndex
CREATE UNIQUE INDEX "locker_compartments_stationId_compartmentNo_key" ON "locker_compartments"("stationId", "compartmentNo");

-- CreateIndex
CREATE INDEX "locker_assignments_parcelId_idx" ON "locker_assignments"("parcelId");

-- CreateIndex
CREATE INDEX "locker_assignments_compartmentId_idx" ON "locker_assignments"("compartmentId");

-- CreateIndex
CREATE INDEX "locker_requests_parcelId_status_idx" ON "locker_requests"("parcelId", "status");

-- CreateIndex
CREATE INDEX "locker_requests_status_createdAt_idx" ON "locker_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "collection_codes_lockerAssignmentId_idx" ON "collection_codes"("lockerAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "parcel_seals_parcelId_key" ON "parcel_seals"("parcelId");

-- CreateIndex
CREATE UNIQUE INDEX "parcel_seals_identifier_key" ON "parcel_seals"("identifier");

-- CreateIndex
CREATE INDEX "seal_scans_parcelId_createdAt_idx" ON "seal_scans"("parcelId", "createdAt");

-- CreateIndex
CREATE INDEX "seal_scans_sealId_idx" ON "seal_scans"("sealId");

-- CreateIndex
CREATE INDEX "tamper_alerts_parcelId_status_idx" ON "tamper_alerts"("parcelId", "status");

-- CreateIndex
CREATE INDEX "demand_forecasts_routeId_periodStart_idx" ON "demand_forecasts"("routeId", "periodStart");

-- CreateIndex
CREATE INDEX "forecast_metrics_forecastId_idx" ON "forecast_metrics"("forecastId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "parcels_parcelNumber_key" ON "parcels"("parcelNumber");

-- CreateIndex
CREATE UNIQUE INDEX "parcels_qrSealIdentifier_key" ON "parcels"("qrSealIdentifier");

-- CreateIndex
CREATE INDEX "parcels_routeId_idx" ON "parcels"("routeId");

-- CreateIndex
CREATE INDEX "reviews_revieweeId_idx" ON "reviews"("revieweeId");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_parcelId_reviewerId_reviewType_key" ON "reviews"("parcelId", "reviewerId", "reviewType");

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
