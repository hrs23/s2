import { useTranslation } from "react-i18next";
import type { AccessPathsError } from "~/lib/access-paths/validate";

const ERROR_KEY: Record<AccessPathsError["kind"], string> = {
  duplicate_paths: "errors.duplicatePaths",
  min_rows: "errors.minRows",
};

/** Shared inline error renderer for the 3 surfaces that drive
 *  AccessPathEditor (OAuth consent / Token dialogs / Connection edit).
 *  Pass the result of `validateAccessPaths(...)` directly. */
export function AccessPathsValidationError({
  error,
}: {
  error: AccessPathsError | null;
}) {
  const { t } = useTranslation("access-paths");
  if (!error) return null;
  return (
    <p role="alert" aria-live="polite" className="mt-1 text-xs text-red-600">
      {t(ERROR_KEY[error.kind])}
    </p>
  );
}
