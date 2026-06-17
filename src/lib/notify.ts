import { toast, type ExternalToast } from "sonner";
import { getErrorMessage } from "@/lib/utils";

const DEFAULT_ERROR_DURATION = 8000;

export function notifyError(message: string, options?: ExternalToast) {
  return toast.error(message, {
    duration: DEFAULT_ERROR_DURATION,
    ...options,
  });
}

export function notifyUnknownError(
  err: unknown,
  fallback = "Unexpected error",
  options?: ExternalToast,
) {
  notifyError(getErrorMessage(err, fallback), options);
}

export function notifySuccess(message: string, options?: ExternalToast) {
  return toast.success(message, options);
}

export function notifyInfo(message: string, options?: ExternalToast) {
  return toast.info(message, options);
}

let lastDedupedErrorKey: string | null = null;

/** Show an error toast at most once per dedupe key until key is cleared (null). */
export function resetNotifyErrorDedup() {
  lastDedupedErrorKey = null;
}

/** Show an error toast at most once per dedupe key until reset. */
export function notifyErrorDeduped(dedupeKey: string, message: string, options?: ExternalToast) {
  if (lastDedupedErrorKey === dedupeKey) return;
  lastDedupedErrorKey = dedupeKey;
  notifyError(message, options);
}
