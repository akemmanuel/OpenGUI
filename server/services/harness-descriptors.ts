import { HARNESS_LABELS } from "../../src/agents/index.ts";
import type { BackendServiceContext } from "./index.ts";

export function listManagedHarnessDescriptors(input: { services: BackendServiceContext }) {
  return input.services.harnesses.getManagedHarnessIds().map((id) => ({
    id,
    label: HARNESS_LABELS[id as keyof typeof HARNESS_LABELS],
  }));
}
