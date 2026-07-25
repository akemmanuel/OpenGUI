import { useEffect, useState } from "react";
import type { Session } from "@/hooks/agent-state-types";
import { normalizeProjectPath } from "@/lib/path";

const SEARCH_DEBOUNCE_MS = 35;
const DIRECTORY_SEPARATOR = "\0";
const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();

export function useSessionMessageSearch({
  sessions,
  query,
  searchSessionMessages,
}: {
  sessions: Session[];
  query: string;
  searchSessionMessages: (directories: readonly string[], query: string) => Promise<string[]>;
}) {
  const normalizedQuery = query.trim();
  const directoriesKey = Array.from(
    new Set(
      sessions
        .map((session) => normalizeProjectPath(session._projectDir ?? session.directory ?? ""))
        .filter(Boolean),
    ),
  ).join(DIRECTORY_SEPARATOR);
  const searchKey =
    normalizedQuery && directoriesKey ? `${directoriesKey}\u0001${normalizedQuery}` : "";
  const [result, setResult] = useState<{
    searchKey: string;
    query: string;
    matchingSessionIds: ReadonlySet<string>;
  }>({ searchKey: "", query: "", matchingSessionIds: EMPTY_SESSION_IDS });

  useEffect(() => {
    let stale = false;
    if (!searchKey) {
      setResult((current) =>
        current.searchKey
          ? { searchKey: "", query: "", matchingSessionIds: EMPTY_SESSION_IDS }
          : current,
      );
      return;
    }

    const timer = window.setTimeout(() => {
      const directories = directoriesKey.split(DIRECTORY_SEPARATOR);
      void searchSessionMessages(directories, normalizedQuery).then(
        (ids) => {
          if (!stale) {
            setResult({ searchKey, query: normalizedQuery, matchingSessionIds: new Set(ids) });
          }
        },
        () => {
          if (!stale) {
            setResult({ searchKey, query: normalizedQuery, matchingSessionIds: EMPTY_SESSION_IDS });
          }
        },
      );
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [directoriesKey, normalizedQuery, searchKey, searchSessionMessages]);

  const isPending = Boolean(searchKey) && result.searchKey !== searchKey;
  if (!searchKey) {
    return {
      matchingSessionIds: EMPTY_SESSION_IDS,
      effectiveQuery: "",
      isPending: false,
    };
  }
  return {
    matchingSessionIds: result.matchingSessionIds,
    effectiveQuery: isPending ? result.query : normalizedQuery,
    isPending,
  };
}
