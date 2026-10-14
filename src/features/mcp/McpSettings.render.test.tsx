// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HostMcpConnection, HostMcpToolInfo } from "@/protocol/host-types";

const host = {
  listMcpConnections: vi.fn<() => Promise<HostMcpConnection[]>>(async () => []),
  upsertMcpConnection: vi.fn(async (connection) => connection),
  inspectMcpConnection: vi.fn(async (): Promise<HostMcpToolInfo[]> => []),
  removeMcpConnection: vi.fn(async () => undefined),
};

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/protocol/host-client", () => ({ createHostClient: () => host }));
vi.mock("@/features/identity/workspace-identity", () => ({
  getIdentityWorkspace: () => ({ serverUrl: "https://host.example", authToken: "token" }),
}));
vi.mock("@/lib/notify", () => ({
  notifyUnknownError: vi.fn(),
  notifySuccess: vi.fn(),
}));

import { McpSettings } from "./McpSettings";

describe("McpSettings", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    host.listMcpConnections.mockReset().mockResolvedValue([]);
  });

  test("shows actionable health for an unavailable connection", async () => {
    host.listMcpConnections.mockResolvedValueOnce([
      {
        id: "search",
        label: "Search tools",
        enabled: true,
        transport: { kind: "http", url: "https://example.com/mcp" },
        status: {
          state: "offline",
          toolCount: 0,
          lastCheckedAt: "2026-07-30T12:00:00.000Z",
          problem: {
            code: "timeout",
            stage: "connect",
            message: "MCP connection timed out",
            retryable: true,
          },
        },
      },
    ] as HostMcpConnection[]);

    render(<McpSettings />);

    await waitFor(() => expect(screen.getByText("mcp.status.offline")).toBeTruthy());
    expect(screen.getByText("mcp.problem.timeout")).toBeTruthy();
  });

  test("turns a pasted command into a reviewed connection and tests it after saving", async () => {
    host.upsertMcpConnection.mockImplementationOnce(async (connection) => ({
      ...connection,
      transport: { ...connection.transport, envKeys: ["API_KEY"] },
    }));
    host.inspectMcpConnection.mockResolvedValueOnce([
      { name: "list_events", title: "", description: "List calendar events" },
    ]);
    render(<McpSettings />);
    const paste = await screen.findByLabelText("mcp.paste.label");

    await userEvent.type(paste, "API_KEY=secret node calendar-mcp.mjs --port 'my port'");
    await userEvent.click(screen.getByRole("button", { name: "mcp.paste.continue" }));

    expect((screen.getByLabelText("mcp.fields.label") as HTMLInputElement).value).toBe("Calendar");
    expect((screen.getByLabelText("mcp.fields.commandLine") as HTMLInputElement).value).toBe(
      "node calendar-mcp.mjs --port 'my port'",
    );
    expect((screen.getByLabelText("mcp.variableName") as HTMLInputElement).value).toBe("API_KEY");

    const save = screen.getByRole("button", { name: "mcp.save" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("checkbox"));
    expect(save.hasAttribute("disabled")).toBe(false);
    await userEvent.click(save);

    await waitFor(() =>
      expect(host.upsertMcpConnection).toHaveBeenCalledWith({
        id: "calendar",
        label: "Calendar",
        enabled: true,
        commandApproved: true,
        transport: {
          kind: "stdio",
          command: "node",
          args: ["calendar-mcp.mjs", "--port", "my port"],
          env: { API_KEY: "secret" },
        },
      }),
    );
    await waitFor(() => expect(host.inspectMcpConnection).toHaveBeenCalledWith("calendar"));
  });

  test("editing the command requires approval again", async () => {
    host.listMcpConnections.mockResolvedValue([
      {
        id: "calendar",
        label: "Calendar",
        enabled: true,
        transport: { kind: "stdio", command: "node", args: ["server.mjs"], envKeys: [] },
      },
    ] as HostMcpConnection[]);
    render(<McpSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /Calendar/u }));
    await userEvent.click(screen.getByRole("button", { name: "common.edit" }));

    const save = screen.getByRole("button", { name: "mcp.saveChanges" });
    expect(save.hasAttribute("disabled")).toBe(false);
    await userEvent.type(screen.getByLabelText("mcp.fields.commandLine"), " --verbose");
    expect(save.hasAttribute("disabled")).toBe(true);
  });

  test("keeps saved secrets unless the person replaces them", async () => {
    host.listMcpConnections.mockResolvedValue([
      {
        id: "search",
        label: "Search",
        enabled: false,
        transport: { kind: "http", url: "https://mcp.search.dev/mcp", bearerTokenConfigured: true },
      },
      {
        id: "github",
        label: "GitHub",
        enabled: false,
        transport: { kind: "stdio", command: "npx", args: ["gh-mcp"], envKeys: ["TOKEN", "ORG"] },
      },
    ] as HostMcpConnection[]);
    render(<McpSettings />);

    await userEvent.click(await screen.findByRole("button", { name: /Search/u }));
    await userEvent.click(screen.getByRole("button", { name: "common.edit" }));
    expect(screen.getByText("mcp.tokenSavedHelp")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "mcp.saveChanges" }));
    await waitFor(() => expect(host.upsertMcpConnection).toHaveBeenCalledTimes(1));
    expect(host.upsertMcpConnection.mock.calls[0]?.[0].transport).toEqual({
      kind: "http",
      url: "https://mcp.search.dev/mcp",
    });

    await userEvent.click(screen.getByRole("button", { name: /GitHub/u }));
    await userEvent.click(screen.getAllByRole("button", { name: "common.edit" })[0] as HTMLElement);
    expect(screen.getByText("mcp.envSaved")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "mcp.envReplace" }));
    await userEvent.type(
      screen.getAllByLabelText("mcp.variableValue")[0] as HTMLElement,
      "new-token",
    );
    await userEvent.click(screen.getByRole("button", { name: "mcp.saveChanges" }));
    await waitFor(() => expect(host.upsertMcpConnection).toHaveBeenCalledTimes(2));
    expect(host.upsertMcpConnection.mock.calls[1]?.[0].transport).toMatchObject({
      kind: "stdio",
      env: { TOKEN: "new-token" },
    });
  });

  test("explains unrecognised input instead of guessing", async () => {
    render(<McpSettings />);
    const paste = await screen.findByLabelText("mcp.paste.label");
    await userEvent.type(paste, "https://example.com/mcp and more");
    await userEvent.click(screen.getByRole("button", { name: "mcp.paste.continue" }));
    expect(screen.getByRole("alert").textContent).toBe("mcp.paste.unrecognized");
  });

  test("polls until background discovery leaves the refreshing state", async () => {
    const connection = {
      id: "calendar",
      label: "Calendar",
      enabled: true,
      transport: {
        kind: "http" as const,
        url: "https://example.com/mcp",
        bearerTokenConfigured: false,
      },
    };
    host.listMcpConnections
      .mockResolvedValueOnce([
        { ...connection, status: { state: "refreshing" as const, toolCount: 0 } },
      ])
      .mockResolvedValueOnce([
        {
          ...connection,
          status: {
            state: "ready" as const,
            toolCount: 2,
            lastCheckedAt: "2026-07-31T12:00:00.000Z",
          },
        },
      ]);

    render(<McpSettings />);
    await waitFor(() => expect(screen.getByText("mcp.status.refreshing")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("mcp.toolCount")).toBeTruthy(), {
      timeout: 2_000,
    });
    expect(host.listMcpConnections).toHaveBeenCalledTimes(2);
  });
});
