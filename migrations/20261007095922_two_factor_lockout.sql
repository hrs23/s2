-- migrate:up
ALTER TABLE public."twoFactor" ADD COLUMN IF NOT EXISTS "failedVerificationCount" integer;
ALTER TABLE public."twoFactor" ADD COLUMN IF NOT EXISTS "lockedUntil" timestamp with time zone;

-- migrate:down
-- Rollback is not supported. Drop the database and re-run migrations.
