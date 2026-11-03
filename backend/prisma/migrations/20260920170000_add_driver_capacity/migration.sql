ALTER TABLE "users"
  ADD COLUMN "maxLoadKg" DOUBLE PRECISION,
  ADD COLUMN "maxDistanceKm" DOUBLE PRECISION;

-- Existing motorcycles receive the policy defaults; other vehicle capacities
-- must be set by an administrator before capacity-based dispatch.
UPDATE "users"
SET "maxLoadKg" = 15, "maxDistanceKm" = 80
WHERE "vehicleType" = 'MOTORCYCLE' AND "maxLoadKg" IS NULL;
