-- Baseline for tables and enum values that earlier environments created with prisma db push.
-- Every statement is idempotent so it is safe on databases that already contain these objects.

DO $$ BEGIN CREATE TYPE "DriverStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "AssignmentStatus" AS ENUM ('ASSIGNED', 'ACKNOWLEDGED', 'COLLECTED', 'COMPLETED', 'CANCELLED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "BatchStatus" AS ENUM ('CREATED', 'IN_TRANSIT', 'SPLIT', 'MERGED', 'CLOSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "LockerSize" AS ENUM ('SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "LockerStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'OCCUPIED', 'OUT_OF_SERVICE', 'AWAITING_COLLECTION', 'COLLECTION_COMPLETED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "SealCondition" AS ENUM ('INTACT', 'DAMAGED', 'BROKEN', 'QR_MISMATCH'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "TamperAlertType" AS ENUM ('SEAL_DAMAGED', 'SEAL_BROKEN', 'QR_MISMATCH', 'DUPLICATE_QR', 'SKIPPED_TRANSIT_POINT', 'INVALID_SEQUENCE', 'UNAUTHORISED_SCAN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'UNDER_INVESTIGATION', 'RESOLVED', 'ESCALATED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'created';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'awaiting_confirmation';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'awaiting_driver_assignment';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'awaiting_pickup';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'collected';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'at_origin_transit_point';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'arrived_at_transit_point';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'at_transit_point';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'at_destination';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'batch_transferred';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'out_for_delivery';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'locker_assigned';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'ready_for_locker_collection';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'in_locker';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'collected_from_locker';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'delivery_unsuccessful';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'returned';

ALTER TYPE "ParcelStatus" ADD VALUE IF NOT EXISTS 'tampering_alert';

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'TRANSIT_OFFICER';

ALTER TABLE "parcels" ADD COLUMN IF NOT EXISTS "category" TEXT,
ADD COLUMN IF NOT EXISTS "currentTransitPointId" TEXT,
ADD COLUMN IF NOT EXISTS "deliveryMethod" TEXT,
ADD COLUMN IF NOT EXISTS "dimensions" TEXT,
ADD COLUMN IF NOT EXISTS "isFragile" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "parcelNumber" TEXT,
ADD COLUMN IF NOT EXISTS "preferredPickupAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "qrSealIdentifier" TEXT,
ADD COLUMN IF NOT EXISTS "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS "routeId" TEXT;

CREATE TABLE IF NOT EXISTS "customer_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "driver_profiles" (
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

CREATE TABLE IF NOT EXISTS "driver_documents" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publicId" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "parcel_assignments" (
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

CREATE TABLE IF NOT EXISTS "routes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "transit_points" (
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

CREATE TABLE IF NOT EXISTS "route_transit_points" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "transitPointId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "instructions" TEXT,

    CONSTRAINT "route_transit_points_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "batches" (
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

CREATE TABLE IF NOT EXISTS "batch_parcels" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loadedAt" TIMESTAMP(3),
    "loadedBy" TEXT,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "batch_parcels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "batch_events" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "transitPointId" TEXT,
    "type" TEXT NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "transit_inspections" (
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

CREATE TABLE IF NOT EXISTS "locker_stations" (
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

CREATE TABLE IF NOT EXISTS "locker_compartments" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "compartmentNo" TEXT NOT NULL,
    "size" "LockerSize" NOT NULL,
    "status" "LockerStatus" NOT NULL DEFAULT 'AVAILABLE',
    "currentParcelId" TEXT,
    "lastMaintenance" TIMESTAMP(3),

    CONSTRAINT "locker_compartments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "locker_assignments" (
    "id" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "compartmentId" TEXT NOT NULL,
    "assignedBy" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "locker_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "locker_requests" (
    "id" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "stationId" TEXT,
    "size" "LockerSize" NOT NULL DEFAULT 'MEDIUM',
    "requestedMinutes" INTEGER NOT NULL DEFAULT 1440,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locker_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "collection_codes" (
    "id" TEXT NOT NULL,
    "lockerAssignmentId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "parcel_seals" (
    "id" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "signedData" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parcel_seals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "seal_scans" (
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

CREATE TABLE IF NOT EXISTS "tamper_alerts" (
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

CREATE TABLE IF NOT EXISTS "demand_forecasts" (
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

CREATE TABLE IF NOT EXISTS "forecast_metrics" (
    "id" TEXT NOT NULL,
    "forecastId" TEXT NOT NULL,
    "actual" DOUBLE PRECISION NOT NULL,
    "error" DOUBLE PRECISION NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forecast_metrics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
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

CREATE TABLE IF NOT EXISTS "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "customer_profiles_userId_key" ON "customer_profiles"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "driver_profiles_userId_key" ON "driver_profiles"("userId");

CREATE INDEX IF NOT EXISTS "driver_profiles_currentRouteId_idx" ON "driver_profiles"("currentRouteId");

CREATE INDEX IF NOT EXISTS "driver_documents_driverId_idx" ON "driver_documents"("driverId");

CREATE INDEX IF NOT EXISTS "parcel_assignments_parcelId_idx" ON "parcel_assignments"("parcelId");

CREATE INDEX IF NOT EXISTS "parcel_assignments_driverId_status_idx" ON "parcel_assignments"("driverId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "routes_name_key" ON "routes"("name");

CREATE INDEX IF NOT EXISTS "transit_points_name_idx" ON "transit_points"("name");

CREATE INDEX IF NOT EXISTS "transit_points_routeId_idx" ON "transit_points"("routeId");

CREATE INDEX IF NOT EXISTS "transit_points_officerId_idx" ON "transit_points"("officerId");

CREATE UNIQUE INDEX IF NOT EXISTS "route_transit_points_routeId_transitPointId_key" ON "route_transit_points"("routeId", "transitPointId");

CREATE UNIQUE INDEX IF NOT EXISTS "route_transit_points_routeId_sequence_key" ON "route_transit_points"("routeId", "sequence");

CREATE UNIQUE INDEX IF NOT EXISTS "batches_batchNumber_key" ON "batches"("batchNumber");

CREATE INDEX IF NOT EXISTS "batches_routeId_idx" ON "batches"("routeId");

CREATE INDEX IF NOT EXISTS "batches_parentBatchId_idx" ON "batches"("parentBatchId");

CREATE INDEX IF NOT EXISTS "batch_parcels_parcelId_idx" ON "batch_parcels"("parcelId");

CREATE UNIQUE INDEX IF NOT EXISTS "batch_parcels_batchId_parcelId_key" ON "batch_parcels"("batchId", "parcelId");

CREATE INDEX IF NOT EXISTS "batch_events_batchId_createdAt_idx" ON "batch_events"("batchId", "createdAt");

CREATE INDEX IF NOT EXISTS "transit_inspections_batchId_inspectedAt_idx" ON "transit_inspections"("batchId", "inspectedAt");

CREATE INDEX IF NOT EXISTS "transit_inspections_parcelId_inspectedAt_idx" ON "transit_inspections"("parcelId", "inspectedAt");

CREATE INDEX IF NOT EXISTS "transit_inspections_transitPointId_officerId_idx" ON "transit_inspections"("transitPointId", "officerId");

CREATE UNIQUE INDEX IF NOT EXISTS "locker_stations_name_key" ON "locker_stations"("name");

CREATE INDEX IF NOT EXISTS "locker_stations_transitPointId_idx" ON "locker_stations"("transitPointId");

CREATE INDEX IF NOT EXISTS "locker_compartments_stationId_status_size_idx" ON "locker_compartments"("stationId", "status", "size");

CREATE UNIQUE INDEX IF NOT EXISTS "locker_compartments_stationId_compartmentNo_key" ON "locker_compartments"("stationId", "compartmentNo");

CREATE INDEX IF NOT EXISTS "locker_assignments_parcelId_idx" ON "locker_assignments"("parcelId");

CREATE INDEX IF NOT EXISTS "locker_assignments_compartmentId_idx" ON "locker_assignments"("compartmentId");

CREATE INDEX IF NOT EXISTS "locker_requests_parcelId_status_idx" ON "locker_requests"("parcelId", "status");

CREATE INDEX IF NOT EXISTS "locker_requests_status_createdAt_idx" ON "locker_requests"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "collection_codes_lockerAssignmentId_idx" ON "collection_codes"("lockerAssignmentId");

CREATE UNIQUE INDEX IF NOT EXISTS "parcel_seals_parcelId_key" ON "parcel_seals"("parcelId");

CREATE UNIQUE INDEX IF NOT EXISTS "parcel_seals_identifier_key" ON "parcel_seals"("identifier");

CREATE INDEX IF NOT EXISTS "seal_scans_parcelId_createdAt_idx" ON "seal_scans"("parcelId", "createdAt");

CREATE INDEX IF NOT EXISTS "seal_scans_sealId_idx" ON "seal_scans"("sealId");

CREATE INDEX IF NOT EXISTS "tamper_alerts_parcelId_status_idx" ON "tamper_alerts"("parcelId", "status");

CREATE INDEX IF NOT EXISTS "demand_forecasts_routeId_periodStart_idx" ON "demand_forecasts"("routeId", "periodStart");

CREATE INDEX IF NOT EXISTS "forecast_metrics_forecastId_idx" ON "forecast_metrics"("forecastId");

CREATE INDEX IF NOT EXISTS "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

CREATE INDEX IF NOT EXISTS "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

CREATE INDEX IF NOT EXISTS "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "parcels_parcelNumber_key" ON "parcels"("parcelNumber");

CREATE UNIQUE INDEX IF NOT EXISTS "parcels_qrSealIdentifier_key" ON "parcels"("qrSealIdentifier");

CREATE INDEX IF NOT EXISTS "parcels_routeId_idx" ON "parcels"("routeId");

CREATE INDEX IF NOT EXISTS "reviews_revieweeId_idx" ON "reviews"("revieweeId");

CREATE UNIQUE INDEX IF NOT EXISTS "reviews_parcelId_reviewerId_reviewType_key" ON "reviews"("parcelId", "reviewerId", "reviewType");

DO $$ BEGIN ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
