-- Parcel journey workflow: frozen journey legs, driver trips with direction/progress,
-- assignment acceptance windows and capacity reservations, custody, and collection deadlines.

-- New enums
CREATE TYPE "TripDirection" AS ENUM ('FORWARD', 'REVERSE');
CREATE TYPE "ParcelLegStatus" AS ENUM ('PLANNED', 'AWAITING_DRIVER', 'DRIVER_ASSIGNED', 'IN_TRANSIT', 'AWAITING_VERIFICATION', 'COMPLETED', 'EXCEPTION', 'CANCELLED');
CREATE TYPE "CustodyHolder" AS ENUM ('SENDER', 'STATION', 'DRIVER', 'HANDOVER', 'LOCKER', 'RECIPIENT', 'UNKNOWN');

-- Assignment states: ACKNOWLEDGED is renamed in place so existing rows keep their meaning.
ALTER TYPE "AssignmentStatus" RENAME VALUE 'ACKNOWLEDGED' TO 'ACCEPTED';
ALTER TYPE "AssignmentStatus" ADD VALUE IF NOT EXISTS 'DROPPED';
ALTER TYPE "AssignmentStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

ALTER TYPE "BatchStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_OFFERED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'OFFICER_ACTION_REQUIRED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PARCEL_READY_FOR_COLLECTION';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PARCEL_EXCEPTION';

ALTER TYPE "TamperAlertType" ADD VALUE IF NOT EXISTS 'PARCEL_MISSING';
ALTER TYPE "TamperAlertType" ADD VALUE IF NOT EXISTS 'PARCEL_DAMAGED';
ALTER TYPE "TamperAlertType" ADD VALUE IF NOT EXISTS 'UNEXPECTED_PARCEL';
ALTER TYPE "TamperAlertType" ADD VALUE IF NOT EXISTS 'ROUTE_UNAVAILABLE';
ALTER TYPE "TamperAlertType" ADD VALUE IF NOT EXISTS 'CUSTODY_EXCEPTION';
ALTER TYPE "TamperAlertType" ADD VALUE IF NOT EXISTS 'COLLECTION_OVERDUE';

-- Trips (the batches table)
ALTER TABLE "batches"
  ADD COLUMN "atStop" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "cancellationReason" TEXT,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "currentTransitPointId" TEXT,
  ADD COLUMN "direction" "TripDirection" NOT NULL DEFAULT 'FORWARD',
  ADD COLUMN "endTransitPointId" TEXT,
  ADD COLUMN "startTransitPointId" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3);

ALTER TABLE "locker_assignments"
  ADD COLUMN "endedReason" TEXT,
  ADD COLUMN "placedAt" TIMESTAMP(3);

ALTER TABLE "parcel_assignments"
  ADD COLUMN "acceptanceDeadline" TIMESTAMP(3),
  ADD COLUMN "cancellationReason" TEXT,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledBy" TEXT,
  ADD COLUMN "collectedAt" TIMESTAMP(3),
  ADD COLUMN "dropTransitPointId" TEXT,
  ADD COLUMN "droppedAt" TIMESTAMP(3),
  ADD COLUMN "expiredAt" TIMESTAMP(3),
  ADD COLUMN "legId" TEXT,
  ADD COLUMN "reservedWeightKg" DOUBLE PRECISION,
  ADD COLUMN "tripId" TEXT;

-- Parcels: collection method must be known before the column becomes required.
UPDATE "parcels" SET "deliveryMethod" = 'SMART_LOCKER'
WHERE "id" IN (SELECT "parcelId" FROM "locker_requests");
UPDATE "parcels" SET "deliveryMethod" = 'STATION_COLLECTION'
WHERE "deliveryMethod" IS NULL OR "deliveryMethod" NOT IN ('STATION_COLLECTION', 'SMART_LOCKER');

ALTER TABLE "parcels"
  ADD COLUMN "collectionDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "collectionOverdueAlertedAt" TIMESTAMP(3),
  ADD COLUMN "custody" "CustodyHolder" NOT NULL DEFAULT 'SENDER',
  ADD COLUMN "destinationTransitPointId" TEXT,
  ADD COLUMN "originConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "originConfirmedBy" TEXT,
  ADD COLUMN "originTransitPointId" TEXT,
  ADD COLUMN "readyForCollectionAt" TIMESTAMP(3),
  ALTER COLUMN "status" SET DEFAULT 'awaiting_confirmation',
  ALTER COLUMN "deliveryMethod" SET NOT NULL,
  ALTER COLUMN "deliveryMethod" SET DEFAULT 'STATION_COLLECTION';

ALTER TABLE "route_transit_points" ADD COLUMN "distanceFromPreviousKm" DOUBLE PRECISION;

ALTER TABLE "tamper_alerts"
  ADD COLUMN "assignmentId" TEXT,
  ADD COLUMN "legId" TEXT,
  ADD COLUMN "transitPointId" TEXT,
  ADD COLUMN "tripId" TEXT;

ALTER TABLE "transit_inspections"
  ADD COLUMN "assignmentId" TEXT,
  ADD COLUMN "legId" TEXT,
  ALTER COLUMN "batchId" DROP NOT NULL,
  ALTER COLUMN "condition" DROP NOT NULL;

CREATE TABLE "parcel_legs" (
    "id" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "routeId" TEXT NOT NULL,
    "direction" "TripDirection" NOT NULL,
    "fromTransitPointId" TEXT NOT NULL,
    "toTransitPointId" TEXT NOT NULL,
    "isFinal" BOOLEAN NOT NULL,
    "status" "ParcelLegStatus" NOT NULL DEFAULT 'PLANNED',
    "distanceKm" DOUBLE PRECISION,
    "activatedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),
    "droppedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "noDriverReason" TEXT,
    "lastAssignmentAttemptAt" TIMESTAMP(3),
    "attentionNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "parcel_legs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "parcel_legs_status_fromTransitPointId_idx" ON "parcel_legs"("status", "fromTransitPointId");
CREATE INDEX "parcel_legs_toTransitPointId_status_idx" ON "parcel_legs"("toTransitPointId", "status");
CREATE INDEX "parcel_legs_routeId_status_idx" ON "parcel_legs"("routeId", "status");
CREATE UNIQUE INDEX "parcel_legs_parcelId_sequence_key" ON "parcel_legs"("parcelId", "sequence");
CREATE INDEX "batches_driverId_status_idx" ON "batches"("driverId", "status");
CREATE INDEX "parcel_assignments_legId_idx" ON "parcel_assignments"("legId");
CREATE INDEX "parcel_assignments_tripId_status_idx" ON "parcel_assignments"("tripId", "status");
CREATE INDEX "parcel_assignments_status_acceptanceDeadline_idx" ON "parcel_assignments"("status", "acceptanceDeadline");
CREATE INDEX "parcels_originTransitPointId_idx" ON "parcels"("originTransitPointId");
CREATE INDEX "parcels_destinationTransitPointId_idx" ON "parcels"("destinationTransitPointId");
CREATE INDEX "parcels_currentTransitPointId_status_idx" ON "parcels"("currentTransitPointId", "status");
CREATE INDEX "tamper_alerts_transitPointId_status_idx" ON "tamper_alerts"("transitPointId", "status");
CREATE UNIQUE INDEX "transit_inspections_assignmentId_key" ON "transit_inspections"("assignmentId");

ALTER TABLE "parcel_assignments" ADD CONSTRAINT "parcel_assignments_legId_fkey" FOREIGN KEY ("legId") REFERENCES "parcel_legs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "parcel_assignments" ADD CONSTRAINT "parcel_assignments_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "parcel_legs" ADD CONSTRAINT "parcel_legs_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
