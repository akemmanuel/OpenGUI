import type { AdapterObservation } from "./adapter-observation.ts";
import type {
  LiveSessionEvent,
  LiveSessionEventHandler,
  LiveSessionScope,
} from "./live-session-event.ts";
import { LiveSessionEventNormalizer } from "./live-session-normalizer.ts";

export class LiveSessionEventBus {
  private normalizer = new LiveSessionEventNormalizer();
  private scopeHandlers = new Map<string, Set<LiveSessionEventHandler>>();
  private harnessHandlers = new Map<string, Set<LiveSessionEventHandler>>();

  publish(observations: AdapterObservation[]): LiveSessionEvent[] {
    const events = observations.flatMap((observation) => this.normalizer.ingest(observation));
    for (const event of events) this.dispatch(event);
    return events;
  }

  onScope(scope: LiveSessionScope, handler: LiveSessionEventHandler): () => void {
    return this.add(this.scopeHandlers, scopeKey(scope), handler);
  }

  onHarness(harnessId: string, handler: LiveSessionEventHandler): () => void {
    return this.add(this.harnessHandlers, harnessId, handler);
  }

  evict(scope: LiveSessionScope): void {
    this.normalizer.evict(scope);
    this.scopeHandlers.delete(scopeKey(scope));
  }

  private dispatch(event: LiveSessionEvent): void {
    for (const handler of this.scopeHandlers.get(scopeKey(event.scope)) ?? []) handler(event);
    for (const handler of this.harnessHandlers.get(event.scope.harnessId) ?? []) handler(event);
  }

  private add(
    handlers: Map<string, Set<LiveSessionEventHandler>>,
    key: string,
    handler: LiveSessionEventHandler,
  ): () => void {
    let set = handlers.get(key);
    if (!set) {
      set = new Set();
      handlers.set(key, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set?.size === 0) handlers.delete(key);
    };
  }
}

function scopeKey(scope: LiveSessionScope): string {
  return `${scope.directory}\u0000${scope.harnessId}\u0000${scope.sessionId}`;
}
