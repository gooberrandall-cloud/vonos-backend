-- Login by username (optional, unique when set)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");

-- Multi-location allocation for employees / users linked into HRM
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "locationCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "Employee"
SET "locationCodes" = ARRAY["locationCode"]
WHERE "locationCode" IS NOT NULL
  AND TRIM("locationCode") <> ''
  AND (cardinality("locationCodes") = 0 OR "locationCodes" IS NULL);
