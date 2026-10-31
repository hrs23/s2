-- migrate:up
UPDATE public."twoFactor" SET "failedVerificationCount" = 0 WHERE "failedVerificationCount" IS NULL;
ALTER TABLE public."twoFactor" ALTER COLUMN "failedVerificationCount" SET DEFAULT 0, ALTER COLUMN "failedVerificationCount" SET NOT NULL;

-- migrate:down
-- Rollback is not supported. Drop the database and re-run migrations.
