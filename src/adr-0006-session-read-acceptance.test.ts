/**
 * Automated acceptance for ADR 0006 / docs/manual/session-read-acceptance.md.
 * Maps each manual checklist row to backend + protocol + frontend unit tests.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import type { HarnessId } from "@/agents";
import type { BackendServiceContext } from "../server/services/index.ts";
import {
  listSessionsForRequest,
  querySessionsForResolvedProjects,
} from "../server/services/session-query.ts";
import { resolveSessionRecordForRead } from "../server/services/session-resolve.ts";
import { fetchSessionMessagePage } from "@/hooks/agent-message-loading";
import { mergeProjectBackendSessions } from "@/hooks/agent-session-index-merge";
import { mapSessionQueryErrorsForProject } from "@/hooks/session-query-errors";
import { reduceSessionActivitySlice } from "@/hooks/agent-reducer-session-activity-slice";
import { initialAgentState } from "@/hooks/agent-initial-state";
import type { Session } from "@/hooks/agent-state-types";
import { createHttpOpenGuiClient } from "@/protocol/http-client";
import { ActiveSessionTranscriptStore } from "@/features/session-transcript/active-session-transcript-store";
import type { ActiveTranscriptScope } from "@/features/session-transcript/transcript-input";

function harnessServices(rawIds: string[] = []) {
  const listDirectorySessions = vi.fn(async () => [
    {
      harnessId: "pi" as const,
      sessions: rawIds.map((rawId) => ({
        id: rawId,
        title: "T",
        status: { type: "idle" },
      })),
    },
  ]);
  return {
    harnesses: { listDirectorySessions },
    sessions: {
      getSession: vi.fn(async () => null),
      ensureSession: vi.fn(),
    },
  } as unknown as BackendServiceContext;
}

function sessionRow(id: string, harnessId: HarnessId = "pi", directory = "/repo"): Session {
  return {
    id,
    title: id,
    directory,
    _projectDir: directory,
    _workspaceId: "ws-1",
    _harnessId: harnessId,
    time: { created: 1, updated: 1 },
  } as Session;
}

const emptyRetain = {
  busySessionIds: new Set<string>(),
  activeTurnRunBySession: {},
  liveSessionRetainUntil: {},
};

describe("ADR 0006 session-read acceptance (automated)", () => {
  describe("step 1–2: list only harness-returned sessions; no recovered ghosts", () => {
    test("query maps only harness rows for each directory + harnessId", async () => {
      const services = harnessServices(["raw-a", "raw-b"]);
      const result = await querySessionsForResolvedProjects({
        services,
        projects: [{ directory: "/repo", canonicalPath: "/repo" }],
        harnessIds: ["pi"],
      });
      expect(result.errors).toEqual([]);
      expect(result.items[0]?.sessions.map((s) => s.id).sort()).toEqual(["pi:raw-a", "pi:raw-b"]);
    });

    test("read resolve rejects unknown wire id (no recovered stub)", async () => {
      const services = harnessServices([]);
      await expect(
        resolveSessionRecordForRead({
          services,
          sessionId: "pi:ghost",
          scope: { directory: "/repo", harnessId: "pi" },
          resolveSafeDirectory: async (p) => p,
        }),
      ).rejects.toThrow(/Session not found/);
    });

    test("merge drops idle in-scope rows when harness list is empty", () => {
      const merged = mergeProjectBackendSessions({
        current: [sessionRow("pi:stale", "pi")],
        workspaceId: "ws-1",
        directory: "/repo",
        incoming: [],
        harnessIds: ["pi"],
        retain: emptyRetain,
      });
      expect(merged).toEqual([]);
    });
  });

  describe("step 3–5: message load errors surface; no silent empty success", () => {
    test("getMessages propagates NOT_FOUND instead of empty page", async () => {
      const client = createHttpOpenGuiClient({
        baseUrl: "http://example.test",
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/messages") && url.includes("pi%3Aunknown")) {
            return new Response(
              JSON.stringify({
                ok: false,
                error: "Session not found",
                code: "NOT_FOUND",
                recoverable: false,
              }),
              { status: 404, headers: { "Content-Type": "application/json" } },
            );
          }
          throw new Error(`Unexpected fetch: ${url}`);
        },
      });

      await expect(
        client.sessions.getMessages({
          sessionId: "pi:unknown",
          harnessId: "pi",
          options: { directory: "/repo", limit: 30 },
        }),
      ).rejects.toMatchObject({ message: "Session not found", code: "NOT_FOUND" });
    });

    test("fetchSessionMessagePage does not swallow client errors", async () => {
      await expect(
        fetchSessionMessagePage({
          sessionsClient: {
            getMessages: async () => {
              throw new Error("Session not found");
            },
          },
          sessions: [sessionRow("pi:unknown")],
          sessionId: "pi:unknown",
          harnessId: "pi",
          projectTarget: { directory: "/repo" },
        }),
      ).rejects.toThrow(/Session not found/);
    });

    test("transcript store enters error phase on initial page.failed", () => {
      const store = new ActiveSessionTranscriptStore();
      const scope: ActiveTranscriptScope = {
        sessionId: "pi:unknown",
        directory: "/repo",
        harnessId: "pi",
      };
      store.select(scope);
      store.dispatch({
        type: "page.failed",
        scope,
        error: "Session not found",
        phase: "initial",
      });
      const snap = store.getSnapshot();
      expect(snap.phase).toBe("error");
      expect(snap.error).toBe("Session not found");
      expect(snap.messages).toEqual([]);
    });

    test("SESSION_ERROR records per-session error for UI", () => {
      const state = initialAgentState;
      const next = reduceSessionActivitySlice(state, {
        type: "SESSION_ERROR",
        payload: { sessionID: "pi:unknown", error: "Session not found" },
      });
      expect(next.sessionErrors["pi:unknown"]).toBe("Session not found");
    });
  });

  describe("step 4: harness list failure is visible (not invented sessions)", () => {
    test("query returns per-scope errors[] when harness is offline", async () => {
      const services = {
        harnesses: {
          listDirectorySessions: async () => {
            throw new Error("Harness offline");
          },
        },
      } as unknown as BackendServiceContext;

      const result = await querySessionsForResolvedProjects({
        services,
        projects: [{ directory: "/repo", canonicalPath: "/repo" }],
        harnessIds: ["pi"],
      });

      expect(result.items).toEqual([]);
      expect(result.errors).toEqual([
        { directory: "/repo", harnessId: "pi", error: "Harness offline" },
      ]);
    });

    test("hydration maps query errors to failedBackends for the project", () => {
      const failed = mapSessionQueryErrorsForProject({
        projectKey: "ws:/repo",
        directory: "/repo",
        harnessIds: ["pi", "codex"],
        queryResult: {
          items: [],
          errors: [{ directory: "/repo", harnessId: "pi", error: "Harness offline" }],
        },
      });
      expect(failed).toEqual({ pi: "Harness offline" });
    });

    test("GET list requires scope and uses harness path only", async () => {
      const services = harnessServices(["s1"]);
      const listed = await listSessionsForRequest({
        services,
        directory: "/repo",
        harnessId: "pi",
        resolveDirectory: async (dir) => ({ directory: dir, canonicalPath: dir }),
      });
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]?.id).toBe("pi:s1");
    });
  });
});
