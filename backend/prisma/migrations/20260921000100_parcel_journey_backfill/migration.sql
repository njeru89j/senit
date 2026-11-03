-- Backfills existing data into the journey workflow and adds the partial unique indexes
-- that Prisma's schema language cannot express. Keep these indexes if a later
-- `prisma migrate dev` proposes dropping them: they enforce the one-active-record rules.

-- 1. Route stops: route endpoints and legacy TransitPoint.routeId stations become ordered stops.
INSERT INTO "route_transit_points" ("id", "routeId", "transitPointId", "sequence")
SELECT 'legacy-' || tp."id" || '-' || tp."routeId", tp."routeId", tp."id",
       COALESCE((SELECT MAX(m."sequence") FROM "route_transit_points" m WHERE m."routeId" = tp."routeId"), 0)
       + ROW_NUMBER() OVER (PARTITION BY tp."routeId" ORDER BY tp."createdAt")
FROM "transit_points" tp
WHERE tp."routeId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "routes" r WHERE r."id" = tp."routeId")
  AND NOT EXISTS (SELECT 1 FROM "route_transit_points" m WHERE m."routeId" = tp."routeId" AND m."transitPointId" = tp."id");

INSERT INTO "route_transit_points" ("id", "routeId", "transitPointId", "sequence")
SELECT 'endpoint-origin-' || r."id", r."id", tp."id",
       COALESCE((SELECT MIN(m."sequence") FROM "route_transit_points" m WHERE m."routeId" = r."id"), 1) - 1
FROM "routes" r
JOIN LATERAL (
  SELECT t."id" FROM "transit_points" t
  WHERE lower(trim(t."name")) = lower(trim(r."origin")) OR lower(trim(t."name")) LIKE lower(trim(r."origin")) || ' %'
  ORDER BY (lower(trim(t."name")) = lower(trim(r."origin"))) DESC, t."createdAt" LIMIT 1
) tp ON true
WHERE NOT EXISTS (SELECT 1 FROM "route_transit_points" m WHERE m."routeId" = r."id" AND m."transitPointId" = tp."id");

INSERT INTO "route_transit_points" ("id", "routeId", "transitPointId", "sequence")
SELECT 'endpoint-destination-' || r."id", r."id", tp."id",
       COALESCE((SELECT MAX(m."sequence") FROM "route_transit_points" m WHERE m."routeId" = r."id"), 0) + 1
FROM "routes" r
JOIN LATERAL (
  SELECT t."id" FROM "transit_points" t
  WHERE lower(trim(t."name")) = lower(trim(r."destination")) OR lower(trim(t."name")) LIKE lower(trim(r."destination")) || ' %'
  ORDER BY (lower(trim(t."name")) = lower(trim(r."destination"))) DESC, t."createdAt" LIMIT 1
) tp ON true
WHERE NOT EXISTS (SELECT 1 FROM "route_transit_points" m WHERE m."routeId" = r."id" AND m."transitPointId" = tp."id");

-- 2. Parcel origin/destination stations (exact station names; bookings always stored the station name).
UPDATE "parcels" p SET "originTransitPointId" = t."id"
FROM "transit_points" t
WHERE p."originTransitPointId" IS NULL AND lower(trim(t."name")) = lower(trim(p."pickupAddress"));

UPDATE "parcels" p SET "destinationTransitPointId" = t."id"
FROM "transit_points" t
WHERE p."destinationTransitPointId" IS NULL AND lower(trim(t."name")) = lower(trim(p."deliveryAddress"));

-- 3. Legacy statuses map onto the reduced customer lifecycle.
UPDATE "parcels" SET "status" = 'awaiting_confirmation' WHERE "status" IN ('created', 'pending');
UPDATE "parcels" SET "status" = CASE
    WHEN "currentTransitPointId" IS NOT NULL AND "originTransitPointId" IS NOT NULL AND "currentTransitPointId" <> "originTransitPointId"
      THEN 'at_transit_point'::"ParcelStatus"
    ELSE 'at_origin_transit_point'::"ParcelStatus" END
  WHERE "status" IN ('awaiting_driver_assignment', 'assigned', 'awaiting_pickup');
UPDATE "parcels" SET "status" = 'collected' WHERE "status" = 'picked_up';
UPDATE "parcels" SET "status" = 'at_transit_point' WHERE "status" = 'batch_transferred';
UPDATE "parcels" SET "status" = 'at_destination' WHERE "status" IN ('out_for_delivery', 'delivery_unsuccessful');
UPDATE "parcels" SET "status" = 'delivered' WHERE "status" IN ('delivered_to_recipient', 'collected_from_locker');
UPDATE "parcels" SET "status" = 'in_locker' WHERE "status" = 'ready_for_locker_collection';

-- 4. Custody follows the (mapped) status.
UPDATE "parcels" SET "custody" = CASE
    WHEN "status" = 'awaiting_confirmation' THEN 'SENDER'::"CustodyHolder"
    WHEN "status" IN ('collected', 'in_transit') THEN 'DRIVER'::"CustodyHolder"
    WHEN "status" = 'arrived_at_transit_point' THEN 'HANDOVER'::"CustodyHolder"
    WHEN "status" = 'in_locker' THEN 'LOCKER'::"CustodyHolder"
    WHEN "status" IN ('delivered', 'completed') THEN 'RECIPIENT'::"CustodyHolder"
    WHEN "status" IN ('cancelled', 'returned') AND "currentTransitPointId" IS NULL THEN 'SENDER'::"CustodyHolder"
    ELSE 'STATION'::"CustodyHolder" END;

UPDATE "parcels" p SET "originConfirmedAt" = COALESCE(
    (SELECT MIN(h."timestamp") FROM "parcel_status_history" h WHERE h."parcelId" = p."id" AND h."status" <> 'awaiting_confirmation'),
    p."createdAt")
WHERE p."status" NOT IN ('awaiting_confirmation', 'cancelled') AND p."originConfirmedAt" IS NULL;

-- 5. Station collection window for parcels already waiting at their destination.
UPDATE "parcels" p SET
  "readyForCollectionAt" = COALESCE((SELECT MAX(h."timestamp") FROM "parcel_status_history" h WHERE h."parcelId" = p."id" AND h."status" = 'at_destination'), p."updatedAt"),
  "collectionDeadlineAt" = COALESCE((SELECT MAX(h."timestamp") FROM "parcel_status_history" h WHERE h."parcelId" = p."id" AND h."status" = 'at_destination'), p."updatedAt") + INTERVAL '12 hours'
WHERE p."status" IN ('at_destination', 'locker_assigned', 'in_locker') AND p."readyForCollectionAt" IS NULL;

-- 6. Open legacy batches become trips from their route's first stop.
UPDATE "batches" b SET
  "startTransitPointId" = (SELECT m."transitPointId" FROM "route_transit_points" m WHERE m."routeId" = b."routeId" ORDER BY m."sequence" ASC LIMIT 1),
  "endTransitPointId" = (SELECT m."transitPointId" FROM "route_transit_points" m WHERE m."routeId" = b."routeId" ORDER BY m."sequence" DESC LIMIT 1)
WHERE b."startTransitPointId" IS NULL;

UPDATE "batches" b SET
  "currentTransitPointId" = COALESCE(
    (SELECT e."transitPointId" FROM "batch_events" e WHERE e."batchId" = b."id" AND e."type" LIKE 'ARRIVED%' AND e."transitPointId" IS NOT NULL ORDER BY e."createdAt" DESC LIMIT 1),
    b."startTransitPointId"),
  "atStop" = (b."status" = 'CREATED'),
  "startedAt" = CASE WHEN b."status" = 'CREATED' THEN NULL
    ELSE (SELECT MIN(e."createdAt") FROM "batch_events" e WHERE e."batchId" = b."id" AND e."type" = 'DEPARTED') END,
  "completedAt" = CASE WHEN b."status" = 'CLOSED' THEN b."closedAt" ELSE NULL END
WHERE b."currentTransitPointId" IS NULL;

-- A driver may hold only one open trip; older duplicates are closed.
UPDATE "batches" b SET "status" = 'CLOSED', "closedAt" = COALESCE(b."closedAt", CURRENT_TIMESTAMP),
  "cancellationReason" = 'Closed during journey migration: duplicate open batch'
WHERE b."status" IN ('CREATED', 'IN_TRANSIT') AND b."driverId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "batches" o
    WHERE o."driverId" = b."driverId" AND o."status" IN ('CREATED', 'IN_TRANSIT') AND o."id" <> b."id"
      AND (o."status" = 'IN_TRANSIT' AND b."status" = 'CREATED' OR (o."status" = b."status" AND o."createdAt" > b."createdAt"))
  );

-- 7. Legacy duplicate locker holds: keep the newest active assignment per parcel and per compartment.
UPDATE "locker_assignments" a SET "cancelledAt" = CURRENT_TIMESTAMP, "endedReason" = 'CANCELLED'
WHERE a."collectedAt" IS NULL AND a."cancelledAt" IS NULL
  AND EXISTS (SELECT 1 FROM "locker_assignments" o WHERE o."collectedAt" IS NULL AND o."cancelledAt" IS NULL AND o."id" <> a."id"
              AND (o."parcelId" = a."parcelId" OR o."compartmentId" = a."compartmentId") AND o."assignedAt" > a."assignedAt");
UPDATE "locker_assignments" SET "placedAt" = "assignedAt" WHERE "placedAt" IS NULL;
UPDATE "locker_assignments" SET "endedReason" = 'COLLECTED' WHERE "collectedAt" IS NOT NULL AND "endedReason" IS NULL;
UPDATE "locker_assignments" SET "endedReason" = 'CANCELLED' WHERE "cancelledAt" IS NOT NULL AND "endedReason" IS NULL;

-- 8. One-active-record rules.
CREATE UNIQUE INDEX IF NOT EXISTS "parcel_assignments_one_active_per_leg"
  ON "parcel_assignments" ("legId")
  WHERE "legId" IS NOT NULL AND "status" IN ('ASSIGNED', 'ACCEPTED', 'COLLECTED', 'DROPPED');

CREATE UNIQUE INDEX IF NOT EXISTS "batches_one_open_trip_per_driver"
  ON "batches" ("driverId")
  WHERE "driverId" IS NOT NULL AND "status" IN ('CREATED', 'IN_TRANSIT');

CREATE UNIQUE INDEX IF NOT EXISTS "locker_assignments_one_active_per_parcel"
  ON "locker_assignments" ("parcelId")
  WHERE "collectedAt" IS NULL AND "cancelledAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "locker_assignments_one_active_per_compartment"
  ON "locker_assignments" ("compartmentId")
  WHERE "collectedAt" IS NULL AND "cancelledAt" IS NULL;
