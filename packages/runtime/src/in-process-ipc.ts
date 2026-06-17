import { EventEmitter } from "node:events";

type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;

export interface IpcSender {
  send(channel: string, data: unknown): void;
  isDestroyed?(): boolean;
  destroy?(): void;
}

export interface IpcEvent {
  sender: IpcSender;
}

export class InProcessIpcSender extends EventEmitter implements IpcSender {
  id = 1;
  private destroyed = false;
  private readonly broadcast: (channel: string, data: unknown) => void;

  constructor(broadcast: (channel: string, data: unknown) => void) {
    super();
    this.broadcast = broadcast;
  }

  send(channel: string, data: unknown) {
    this.broadcast(channel, data);
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

/** Minimal ipcMain shim for in-process Runtime (web server + SDK). */
export class InProcessIpcMain {
  private handlers = new Map<string, Handler>();
  private listeners = new Map<string, Handler>();

  handle(channel: string, handler: Handler) {
    if (this.handlers.has(channel)) {
      console.warn(`[runtime] Replacing RPC handler ${channel}`);
    }
    this.handlers.set(channel, handler);
  }

  on(channel: string, handler: Handler) {
    this.listeners.set(channel, handler);
  }

  send(channel: string, event: IpcEvent, args: unknown[] = []) {
    const listener = this.listeners.get(channel);
    if (!listener) return;
    listener(event, ...args);
  }

  async invoke(channel: string, event: IpcEvent, args: unknown[]) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No RPC handler registered for ${channel}`);
    return await handler(event, ...args);
  }
}
