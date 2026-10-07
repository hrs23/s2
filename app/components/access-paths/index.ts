// Re-export the layer-neutral validator so UI callers have a single import.

export { accessPathsForSubmit } from "~/lib/access-paths/submit";
export {
  trimAccessPathRows,
  validateAccessPaths,
} from "~/lib/access-paths/validate";
export {
  type AccessPath,
  AccessPathEditor,
  PathInputWithBrowse,
} from "./AccessPathEditor";
export { AccessPathsValidationError } from "./AccessPathsValidationError";
