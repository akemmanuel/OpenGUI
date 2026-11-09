import { useCallback, useEffect, useRef, useState } from "react";
import { HostFileError } from "./host-file-client";

export type HostRequestState<T> =
  | { status: "loading"; data: T | null }
  | { status: "ready"; data: T }
  | { status: "error"; error: HostFileError; data: null };

/**
 * Cancel obsolete requests and hide their results immediately on navigation
 * or a Host-client change. A null loader disables the request.
 */
export function useHostRequest<T>(
  key: string,
  load: ((signal: AbortSignal) => Promise<T>) | null,
  source?: unknown,
): HostRequestState<T> & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);
  const [result, setResult] = useState<{
    key: string;
    source: unknown;
    state: HostRequestState<T>;
  }>({
    key,
    source,
    state: { status: "loading", data: null },
  });
  const state: HostRequestState<T> =
    load !== null && result.key === key && result.source === source
      ? result.state
      : { status: "loading", data: null };
  const setState = (
    next: HostRequestState<T> | ((previous: HostRequestState<T>) => HostRequestState<T>),
  ) => {
    setResult((previous) => ({
      key,
      source,
      state:
        typeof next === "function"
          ? next(
              previous.key === key && previous.source === source
                ? previous.state
                : { status: "loading", data: null },
            )
          : next,
    }));
  };
  // `load` is recreated every render; `key` says when it does something else.
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabled = load !== null;

  useEffect(() => {
    const run = loadRef.current;
    if (!run) return;
    const controller = new AbortController();
    setState((previous) => ({ status: "loading", data: previous.data }));
    run(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          data: null,
          error:
            error instanceof HostFileError
              ? error
              : new HostFileError("failed", error instanceof Error ? error.message : String(error)),
        });
      },
    );
    return () => controller.abort();
  }, [key, enabled, source, attempt]);

  return { ...state, retry };
}
