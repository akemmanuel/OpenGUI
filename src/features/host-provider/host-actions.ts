import { useMemo, type DependencyList } from "react";
import type { ActionsContextValue } from "@/hooks/agent-contexts";
import type { ActorSnapshot, HostFollowUp, OpenGuiHostClient } from "@/protocol/host-types";

export type HostQueueItem = {
  id: string;
  text: string;
  mode: "queue";
  actor?: ActorSnapshot;
};
export type HostQueueState = Record<string, HostQueueItem[]>;
type UpdateHostQueueState = (update: (current: HostQueueState) => HostQueueState) => void;

export function projectHostFollowUps(followUps: HostFollowUp[]): HostQueueItem[] {
  return followUps.map((item) => ({
    id: item.id,
    text: item.prompt.text,
    mode: "queue",
    actor: item.prompt.actor,
  }));
}

/** Coordinates Host-owned Follow-up mutations and their frontend projection. */
export class HostQueueController {
  constructor(
    private readonly host: OpenGuiHostClient,
    private readonly getState: () => HostQueueState,
    private readonly updateState: UpdateHostQueueState,
  ) {}

  #replace(sessionId: string, followUps: HostFollowUp[]) {
    this.updateState((current) => ({ ...current, [sessionId]: projectHostFollowUps(followUps) }));
  }

  recordEnqueued(sessionId: string, followUp: HostFollowUp) {
    this.updateState((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []).filter((item) => item.id !== followUp.id),
        ...projectHostFollowUps([followUp]),
      ],
    }));
  }

  recordDispatched(sessionId: string, followUpId: string) {
    this.updateState((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).filter((item) => item.id !== followUpId),
    }));
  }

  async update(sessionId: string, followUpId: string, text: string) {
    this.#replace(sessionId, await this.host.updateFollowUp(sessionId, followUpId, text));
  }

  async reorder(sessionId: string, fromIndex: number, toIndex: number) {
    const followUp = this.getState()[sessionId]?.[fromIndex];
    if (!followUp) return;
    this.#replace(sessionId, await this.host.reorderFollowUp(sessionId, followUp.id, toIndex));
  }

  async remove(sessionId: string, followUpId: string) {
    this.#replace(sessionId, await this.host.removeFollowUp(sessionId, followUpId));
  }

  async sendNow(sessionId: string, followUpId: string) {
    this.#replace(sessionId, await this.host.sendFollowUpNow(sessionId, followUpId));
  }
}

/**
 * Construction seam for Host actions. Keeping the complete context contract here makes
 * omissions a type error while allowing the provider to supply its current orchestration.
 */
export class HostActionFactory {
  constructor(private readonly createActions: () => ActionsContextValue) {}

  create(): ActionsContextValue {
    return this.createActions();
  }
}

export function useHostActions(
  createActions: () => ActionsContextValue,
  dependencies: DependencyList,
): ActionsContextValue {
  return useMemo(() => new HostActionFactory(createActions).create(), dependencies);
}
