import { REASONING_EFFORTS } from "@opengui/protocol";
import type {
  HostModelConnection,
  HostModelOffering,
  ReasoningEffort,
} from "@/protocol/host-types";

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

/** Offerings carry safe upstream capabilities, never backend routes or credentials. */
export function offeringsToModelConnections(offerings: HostModelOffering[]): HostModelConnection[] {
  if (!offerings.length) return [];
  return [
    {
      id: "opengui-offering",
      label: "OpenGUI",
      baseUrl: "",
      modelIds: offerings.map((offering) => offering.id),
      defaultModelId: offerings[0]?.id,
      modelCapabilities: Object.fromEntries(
        offerings.map((offering) => [
          offering.id,
          {
            displayName: offering.displayName,
            reasoning: true,
            ...offering.modelCapabilities,
          },
        ]),
      ),
    },
  ];
}
