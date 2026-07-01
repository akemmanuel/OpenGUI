import { useMemo } from "react";
import type { MutableRefObject } from "react";
import type { Dispatch } from "react";
import type { Action } from "@/hooks/agent-reducer";
import type { InternalAgentState } from "@/hooks/agent-state-types";
import type { OpenGuiClient } from "@/protocol/client";
import type { LiveSessionEvent, ProjectedTranscriptEvent } from "@opengui/runtime/client";
import {
  useBackendEventSubscription,
  type TranscriptEventHandlers,
} from "./useAgentBackendEventSubscription";

type TitleTrackingRefs = {
  forcedTitles: MutableRefObject<Map<string, string>>;
  pendingTitlePersistence: MutableRefObject<Map<string, string>>;
  sessionIdAliases: MutableRefObject<Map<string, string>>;
  namingRequestIds: MutableRefObject<Map<string, number>>;
};

export function useAgentTranscriptBackendEvents(input: {
  allHarnessesCount: number;
  cleanupSessionRefs: (sessionIds?: Iterable<string>) => void;
  dispatch: Dispatch<Action>;
  openGuiClient: OpenGuiClient;
  workspaces: InternalAgentState["workspaces"];
  expectedProjectKeys: MutableRefObject<Set<string>>;
  titleTracking: TitleTrackingRefs;
  ingestLiveEvent: (event: LiveSessionEvent) => void;
  ingestProjectedTranscriptEvent: (event: ProjectedTranscriptEvent) => boolean;
}) {
  const {
    allHarnessesCount,
    cleanupSessionRefs,
    dispatch,
    openGuiClient,
    workspaces,
    expectedProjectKeys,
    titleTracking,
    ingestLiveEvent,
    ingestProjectedTranscriptEvent,
  } = input;

  const transcriptHandlers = useMemo<TranscriptEventHandlers>(
    () => ({ ingestLiveEvent, ingestProjectedTranscriptEvent }),
    [ingestLiveEvent, ingestProjectedTranscriptEvent],
  );

  useBackendEventSubscription({
    allHarnessesCount,
    cleanupSessionRefs,
    dispatch,
    openGuiClient,
    tracking: {
      expectedProjectKeys,
      forcedTitles: titleTracking.forcedTitles,
      pendingTitlePersistence: titleTracking.pendingTitlePersistence,
      sessionIdAliases: titleTracking.sessionIdAliases,
      namingRequestIds: titleTracking.namingRequestIds,
    },
    workspaces,
    transcriptHandlers,
  });
}
