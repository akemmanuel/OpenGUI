import { useEffect, useRef, useState } from "react";
import { useActions } from "@/hooks/use-agent-state";
import type { HostSkill } from "@/protocol/host-types";

export type SessionSkillsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; skills: HostSkill[] }
  | { status: "error" };

/**
 * Loads the skills the Host would advertise for a project directory.
 * Used by the empty-session agent overview.
 *
 * Host actions are intentionally unstable (rebuilt with session/model state),
 * so this hook only re-fetches when the directory changes.
 */
export function useSessionSkills(directory: string | null | undefined): SessionSkillsState {
  const { listSkills } = useActions();
  const listSkillsRef = useRef(listSkills);
  listSkillsRef.current = listSkills;

  const [state, setState] = useState<SessionSkillsState>(
    directory ? { status: "loading" } : { status: "idle" },
  );

  useEffect(() => {
    if (!directory) {
      setState({ status: "idle" });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    void listSkillsRef
      .current(directory)
      .then((skills) => {
        if (!cancelled) setState({ status: "ready", skills });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [directory]);

  return state;
}
