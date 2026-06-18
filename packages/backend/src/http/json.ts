export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function rpcErrorCode(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("not available") || message.includes("not found"))
    return "BACKEND_UNAVAILABLE";
  if (message.includes("auth") || message.includes("login")) return "AUTH_REQUIRED";
  if (message.includes("permission") || message.includes("denied")) return "PERMISSION_DENIED";
  if (message.includes("timeout") || message.includes("timed out")) return "BACKEND_TIMEOUT";
  return "UNKNOWN";
}

export function jsonError(error: unknown, status = 500) {
  const message = getErrorMessage(error);
  return Response.json(
    { ok: false, error: message, code: rpcErrorCode(error), recoverable: status < 500 },
    { status },
  );
}
