import type { HostSessionSummary, OpenGuiHostClient } from "@/protocol/host-types";

export async function loadHostSessionSummaries(
  host: Pick<OpenGuiHostClient, "listSessions">,
  directories: string[],
): Promise<HostSessionSummary[]> {
  const uniqueDirectories = [...new Set(directories.filter(Boolean))];
  const sessionsByProject = await Promise.all(
    uniqueDirectories.map((directory) => host.listSessions(directory)),
  );
  return sessionsByProject.flat();
}
