import type { HarnessId } from "@opengui/protocol";
import { directoryRef } from "@opengui/runtime";
import type { BackendServiceContext } from "./index.ts";
import type { DirectoryConnectionConfig } from "@opengui/runtime";
import { harnessScopeForDirectory } from "./directory-scope.ts";

function firstHarnessId(harnessIds?: HarnessId[]): HarnessId {
  return harnessIds?.[0] ?? "claude-code";
}

export async function registerDirectoryWithHarnesses(input: {
  services: BackendServiceContext;
  directory: string;
  harnessIds?: HarnessId[];
  config?: DirectoryConnectionConfig;
}) {
  const directory = input.directory.trim();
  if (!directory) {
    return {
      connectedHarnessIds: [] as HarnessId[],
      errors: [] as Array<{ harnessId: HarnessId; error: string }>,
    };
  }
  const harnessIds = input.harnessIds?.length
    ? input.harnessIds
    : [...input.services.harnesses.getManagedHarnessIds()];
  return await input.services.harnesses.registerDirectory({
    directory,
    harnessIds,
    config: input.config,
  });
}

export async function releaseDirectoryFromHarnesses(input: {
  services: BackendServiceContext;
  directory: string;
  harnessIds?: HarnessId[];
}): Promise<void> {
  const directory = input.directory.trim();
  if (!directory) return;
  const harnessIds = input.harnessIds?.length
    ? input.harnessIds
    : [...input.services.harnesses.getManagedHarnessIds()];
  await input.services.harnesses.releaseDirectory({ directory, harnessIds });
}

export async function getDirectoryHarnessStatus(input: {
  services: BackendServiceContext;
  directory: string;
  harnessId?: HarnessId;
}) {
  const directory = input.directory.trim();
  return await input.services.harnesses.getDirectoryStatus({
    directory,
    harnessIds: input.harnessId ? [input.harnessId] : undefined,
  });
}

export async function loadDirectoryHarnessResources(input: {
  services: BackendServiceContext;
  directory: string;
  harnessId: HarnessId;
}) {
  const directory = input.directory.trim();
  const scopeRef = directoryRef(directory);
  return await input.services.harnesses.loadResources({
    scopeRef,
    scope: harnessScopeForDirectory({ canonicalDirectory: directory, harnessId: input.harnessId }),
  });
}

export function directoryHarnessScope(directory: string, harnessId: HarnessId = firstHarnessId()) {
  return harnessScopeForDirectory({ canonicalDirectory: directory, harnessId });
}
