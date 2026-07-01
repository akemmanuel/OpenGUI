import type { LiveSessionEvent } from "./live-session-event.ts";

export interface LiveSessionProjectedPart {
  id: string;
  type: string;
  text?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: string;
}

export interface LiveSessionProjectedMessage {
  id: string;
  role?: string;
  finished: boolean;
  parts: LiveSessionProjectedPart[];
}

export class LiveSessionProjection {
  private status: { type: "idle" | "running" | "error" } = { type: "idle" };
  private messages = new Map<string, LiveSessionProjectedMessage>();

  apply(event: LiveSessionEvent): void {
    switch (event.type) {
      case "run.started":
        this.status = { type: "running" };
        return;
      case "run.finished":
        this.status = { type: event.reason === "error" ? "error" : "idle" };
        return;
      case "session.error":
        this.status = { type: "error" };
        return;
      case "message.started":
        if (event.messageId) this.ensureMessage(event.messageId, event.role);
        return;
      case "message.finished":
        if (event.messageId) this.ensureMessage(event.messageId).finished = true;
        return;
      case "part.started":
        this.ensurePart(event.messageId, event.partId, event.partKind);
        return;
      case "part.text.appended": {
        const part = this.ensurePart(event.messageId, event.partId, event.partKind);
        part.text = `${part.text ?? ""}${event.text}`;
        return;
      }
      case "part.text.replaced": {
        const part = this.ensurePart(event.messageId, event.partId, event.partKind);
        part.text = event.text;
        return;
      }
      case "part.state.changed":
        this.ensurePart(event.messageId, event.partId, "tool").status = event.state;
        return;
      case "tool.started": {
        const part = this.ensurePart(event.messageId, event.partId, "tool");
        part.tool = event.tool;
        part.status ??= "running";
        return;
      }
      case "tool.input.updated":
        this.ensurePart(event.messageId, event.partId, "tool").input = event.input;
        return;
      case "tool.output.appended": {
        const part = this.ensurePart(event.messageId, event.partId, "tool");
        part.output = `${part.output ?? ""}${event.text}`;
        return;
      }
      case "tool.output.replaced":
        this.ensurePart(event.messageId, event.partId, "tool").output = event.text;
        return;
      case "tool.finished":
        this.ensurePart(event.messageId, event.partId, "tool").status = event.status;
        return;
      case "transcript.rebased":
        return;
    }
  }

  /** Pi-style harness replacement: keep streamed parts under the canonical message id. */
  replaceMessageId(oldMessageId: string, newMessageId: string): void {
    if (oldMessageId === newMessageId) return;
    const existing = this.messages.get(oldMessageId);
    if (!existing) return;
    const replacement = this.messages.get(newMessageId);
    if (replacement) {
      replacement.parts = existing.parts.map((part) => ({ ...part }));
      if (!replacement.role && existing.role) replacement.role = existing.role;
      this.messages.delete(oldMessageId);
      return;
    }
    this.messages.set(newMessageId, {
      ...existing,
      id: newMessageId,
      parts: existing.parts.map((part) => ({ ...part })),
    });
    this.messages.delete(oldMessageId);
  }

  getMessages(): LiveSessionProjectedMessage[] {
    return [...this.messages.values()].map((message) => ({
      ...message,
      parts: message.parts.map((part) => ({ ...part })),
    }));
  }

  getStatus(): { type: "idle" | "running" | "error" } {
    return { ...this.status };
  }

  private ensureMessage(id: string | undefined, role?: string): LiveSessionProjectedMessage {
    const messageId = id ?? "unknown-message";
    let message = this.messages.get(messageId);
    if (!message) {
      message = { id: messageId, role, finished: false, parts: [] };
      this.messages.set(messageId, message);
    } else if (role && !message.role) {
      message.role = role;
    }
    return message;
  }

  private ensurePart(
    messageId: string | undefined,
    partId: string | undefined,
    type: string,
  ): LiveSessionProjectedPart {
    const message = this.ensureMessage(messageId);
    const id = partId ?? `${message.id}:unknown-part`;
    let part = message.parts.find((item) => item.id === id);
    if (!part) {
      part = { id, type };
      message.parts.push(part);
    }
    return part;
  }
}
