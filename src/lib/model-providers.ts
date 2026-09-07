import { REASONING_EFFORTS } from "@opengui/protocol";
import type { HostModelConnection, ReasoningEffort } from "@/protocol/host-types";

/** The Host owns metadata. The frontend only projects it for the picker. */
export function connectionsToModelProviders(connections: HostModelConnection[]) {
  return connections.map((connection) => ({
    id: connection.id,
    name: connection.label,
    source: "custom",
    models: Object.fromEntries(
      connection.modelIds.map((id) => {
        const metadata = connection.modelCapabilities?.[id];
        const reasoning = metadata?.reasoning ?? true;
        const efforts = metadata?.reasoningEfforts?.filter((effort) =>
          REASONING_EFFORTS.includes(effort),
        );
        return [
          id,
          {
            id,
            name: metadata?.displayName || id,
            release_date: "",
            capabilities: { reasoning },
            reasoningEfforts: reasoning
              ? efforts?.length
                ? efforts
                : (["none", "high"] as ReasoningEffort[])
              : undefined,
            ...(metadata?.context ? { limit: { context: metadata.context } } : {}),
          },
        ];
      }),
    ),
  }));
}
