import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import {
  ActionsContext,
  ModelContext,
  SessionContext,
  WorkspaceContext,
  type ActionsContextValue,
  type ModelContextValue,
  type SessionContextValue,
  type WorkspaceContextValue,
} from "./agent-contexts";
import { useActions, useModelState, useSessionState, useWorkspaceState } from "./use-agent-state";

function Value({ useValue, field }: { useValue: () => object; field: string }) {
  const value = (useValue() as Record<string, unknown>)[field];
  return <span>{typeof value === "function" ? "function" : String(value)}</span>;
}

describe("agent state contexts", () => {
  test.each([
    [useSessionState, "useSessionState"],
    [useWorkspaceState, "useWorkspaceState"],
    [useModelState, "useModelState"],
    [useActions, "useActions"],
  ])("%s rejects consumers outside its provider", (hook, name) => {
    expect(() => renderToStaticMarkup(<Value useValue={hook} field="missing" />)).toThrow(name);
  });

  test("each domain hook reads only its matching provider", () => {
    const session = { activeSessionId: "session-1" } as SessionContextValue;
    const workspace = { activeWorkspaceId: "workspace-1" } as WorkspaceContextValue;
    const model = { selectedAgent: "agent-1" } as ModelContextValue;
    const actions = { clearError: () => undefined } as ActionsContextValue;

    const markup = renderToStaticMarkup(
      <SessionContext.Provider value={session}>
        <WorkspaceContext.Provider value={workspace}>
          <ModelContext.Provider value={model}>
            <ActionsContext.Provider value={actions}>
              <Value useValue={useSessionState} field="activeSessionId" />
              <Value useValue={useWorkspaceState} field="activeWorkspaceId" />
              <Value useValue={useModelState} field="selectedAgent" />
              <Value useValue={useActions} field="clearError" />
            </ActionsContext.Provider>
          </ModelContext.Provider>
        </WorkspaceContext.Provider>
      </SessionContext.Provider>,
    );

    expect(markup).toContain("session-1");
    expect(markup).toContain("workspace-1");
    expect(markup).toContain("agent-1");
    expect(markup).toContain("function");
  });
});
