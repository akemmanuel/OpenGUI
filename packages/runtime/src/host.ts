import type {
  HarnessControl,
  ManagedHarnessId,
  RegisterHarnessAdaptersInput,
} from "./harness-runtime.ts";
import { MANAGED_HARNESS_IDS, registerHarnessAdapters } from "./harness-runtime.ts";

export interface RuntimeHost {
  readonly managedHarnessIds: readonly ManagedHarnessId[];
  readonly controls: ReadonlyMap<ManagedHarnessId, HarnessControl>;
}

export type CreateRuntimeHostInput = RegisterHarnessAdaptersInput;

/** Embeds harness adapters for one in-process Runtime instance (Phase 1). */
export function createRuntimeHost(input: CreateRuntimeHostInput): RuntimeHost {
  const controls = registerHarnessAdapters(input);
  return {
    managedHarnessIds: MANAGED_HARNESS_IDS,
    controls,
  };
}
