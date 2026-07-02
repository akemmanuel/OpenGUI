import { describe, expect, test } from "vite-plus/test";
import {
  extractOpenCodeEventRawSessionId,
  extractOpenCodeEventSessionDirectory,
  getConnectionForSession,
  normalizeOpenCodeDaemonEvent,
  SESSION_CONNECTION_NOT_FOUND,
} from "../opencode-bridge-mapping.ts";

const normalizeDirectoryHint = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : null;

describe("opencode-bridge-mapping", () => {
  test("normalizeOpenCodeDaemonEvent unwraps sync envelope", () => {
    expect(
      normalizeOpenCodeDaemonEvent({
        type: "sync",
        syncEvent: { type: "message.updated.1", id: "e1", data: { sessionID: "s1" } },
      }),
    ).toMatchObject({
      type: "message.updated",
      properties: { sessionID: "s1" },
    });
  });

  test("extractOpenCodeEventRawSessionId strips opencode prefix", () => {
    expect(
      extractOpenCodeEventRawSessionId({
        type: "message.updated",
        properties: { sessionID: "opencode:abc" },
      }),
    ).toBe("abc");
  });

  test("extractOpenCodeEventSessionDirectory reads info.directory", () => {
    expect(
      extractOpenCodeEventSessionDirectory(
        { properties: { info: { directory: "/my/repo/" } } },
        normalizeDirectoryHint,
      ),
    ).toBe("/my/repo");
  });

  test("#128 getConnectionForSession resolves explicit directory", () => {
    const conn = { id: "c1" };
    const windowState = {
      projectRegistry: {
        getDirectoryConnectionEntry: ({ directory }: { directory?: string }) =>
          directory === "/repo" ? { projectKey: "k", connection: conn } : null,
      },
    };
    expect(getConnectionForSession(windowState, () => [], "opencode:s1", "/repo", "local")).toBe(
      conn,
    );
  });

  test("#128 getConnectionForSession falls back to single connected project", () => {
    const only = { projectKey: "k", connection: { id: "solo" } };
    const windowState = {
      projectRegistry: {
        getDirectoryConnectionEntry: () => null,
      },
    };
    expect(getConnectionForSession(windowState, () => [only], "s1", undefined, undefined)).toEqual({
      id: "solo",
    });
  });

  test("#128 getConnectionForSession returns null when ambiguous", () => {
    const windowState = {
      projectRegistry: { getDirectoryConnectionEntry: () => null },
    };
    const missing = getConnectionForSession(
      windowState,
      () => [
        { projectKey: "a", connection: {} },
        { projectKey: "b", connection: {} },
      ],
      "s1",
      undefined,
      undefined,
    );
    expect(missing).toBeNull();
    expect(SESSION_CONNECTION_NOT_FOUND).toBe("Session connection not found");
  });
});
