CREATE TABLE "transit_point_officers" (
  "id" TEXT NOT NULL,
  "transitPointId" TEXT NOT NULL,
  "officerId" TEXT NOT NULL,
  "nominatedBy" TEXT,
  "nominatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transit_point_officers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "transit_point_officers_officerId_key" ON "transit_point_officers"("officerId");
CREATE UNIQUE INDEX "transit_point_officers_transitPointId_officerId_key" ON "transit_point_officers"("transitPointId", "officerId");
CREATE INDEX "transit_point_officers_transitPointId_idx" ON "transit_point_officers"("transitPointId");

INSERT INTO "transit_point_officers" ("id", "transitPointId", "officerId", "nominatedAt")
SELECT CONCAT('legacy-', "id"), "id", "officerId", CURRENT_TIMESTAMP
FROM "transit_points" WHERE "officerId" IS NOT NULL
ON CONFLICT ("officerId") DO NOTHING;

CREATE TABLE "locker_extension_requests" (
  "id" TEXT NOT NULL,
  "lockerAssignmentId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "requestedMinutes" INTEGER NOT NULL,
  "reason" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "locker_extension_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "locker_extension_requests_lockerAssignmentId_status_idx" ON "locker_extension_requests"("lockerAssignmentId", "status");
CREATE INDEX "locker_extension_requests_status_createdAt_idx" ON "locker_extension_requests"("status", "createdAt");
