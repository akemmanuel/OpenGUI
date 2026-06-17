/**
 * @opengui/backend — networked host embedding Runtime (Phase 0 scaffold).
 */

import { RUNTIME_PACKAGE_ID } from "@opengui/runtime";

export const BACKEND_PACKAGE_ID = "@opengui/backend" as const;

export function getBackendPackagePhase(): "extract-runtime" {
  return "extract-runtime";
}

export function getEmbeddedRuntimeId(): typeof RUNTIME_PACKAGE_ID {
  return RUNTIME_PACKAGE_ID;
}
