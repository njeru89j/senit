-- One phone number may belong to only one SendIT account. PostgreSQL permits
-- multiple NULL values, so existing accounts without a phone remain valid.
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");
