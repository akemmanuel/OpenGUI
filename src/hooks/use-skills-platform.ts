import { useMemo } from "react";
import { useOpenGuiClient } from "@/protocol/provider";

export function useSkillsPlatform() {
  const openGuiClient = useOpenGuiClient();

  return useMemo(() => {
    for (const platform of openGuiClient.agentBackends
      .list()
      .map((entry) => entry.platform)
      .filter(Boolean)) {
      if (platform?.skills) return platform.skills;
    }
  }, [openGuiClient]);
}
