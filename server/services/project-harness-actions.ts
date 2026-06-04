import type { HarnessId } from "../../src/agents/index.ts";
import { HARNESS_LABELS } from "../../src/agents/index.ts";
import type { BackendServiceContext, ProjectRecord } from "./index.ts";
import type { ProjectConnectionConfig } from "./harness-service.ts";
import { buildHarnessScope } from "./harness-scope.ts";

function firstHarnessId(harnessIds?: HarnessId[]): HarnessId {
  return harnessIds?.[0] ?? "opencode";
}

export async function connectProjectToHarnesses(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  harnessIds?: HarnessId[];
  config?: ProjectConnectionConfig;
}) {
  return await input.services.harnesses.connectProject({
    project: input.project,
    scope: buildHarnessScope({
      project: input.project,
      harnessId: firstHarnessId(input.harnessIds),
    }),
    harnessIds: input.harnessIds,
    config: input.config,
  });
}

export async function disconnectProjectFromHarnesses(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  harnessIds?: HarnessId[];
}): Promise<void> {
  await input.services.harnesses.disconnectProject({
    project: input.project,
    scope: buildHarnessScope({
      project: input.project,
      harnessId: firstHarnessId(input.harnessIds),
    }),
    harnessIds: input.harnessIds,
  });
}

export async function getProjectHarnessStatus(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  harnessId?: HarnessId;
}) {
  return await input.services.harnesses.getProjectStatus({
    project: input.project,
    scope: buildHarnessScope({ project: input.project, harnessId: input.harnessId ?? "opencode" }),
    harnessIds: input.harnessId ? [input.harnessId] : undefined,
  });
}

export async function loadProjectHarnessResources(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  harnessId: HarnessId;
}) {
  return await input.services.harnesses.loadResources({
    project: input.project,
    scope: buildHarnessScope({ project: input.project, harnessId: input.harnessId }),
  });
}

export function listManagedHarnessDescriptors(input: { services: BackendServiceContext }) {
  return input.services.harnesses.getManagedHarnessIds().map((id) => ({
    id,
    label: HARNESS_LABELS[id as keyof typeof HARNESS_LABELS],
  }));
}
