export interface RpcEnvelope<T> {
  ok: boolean;
  value?: T;
  error?: string;
  code?: string;
  recoverable?: boolean;
}

export class OpenGuiRpcError extends Error {
  constructor(
    message: string,
    readonly code = "UNKNOWN",
    readonly recoverable = false,
  ) {
    super(message);
    this.name = "OpenGuiRpcError";
  }
}

export function throwRpcError<T>(body: RpcEnvelope<T> | null, fallback: string): never {
  throw new OpenGuiRpcError(body?.error || fallback, body?.code, body?.recoverable);
}
