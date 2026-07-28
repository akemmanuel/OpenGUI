// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

const host = {
  listMcpConnections: vi.fn(async () => []),
  upsertMcpConnection: vi.fn(async (connection) => connection),
  inspectMcpConnection: vi.fn(async () => []),
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
  });

  test("requires explicit approval of the visible stdio command before saving", async () => {
    render(<McpSettings />);
    await waitFor(() => expect(screen.getByText("mcp.emptyTitle")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "mcp.addConnection" }));
    await userEvent.type(screen.getByLabelText("mcp.fields.label"), "Calendar");
    await userEvent.type(screen.getByLabelText("mcp.fields.id"), "calendar");
    await userEvent.type(screen.getByLabelText("mcp.fields.command"), "node");
    await userEvent.type(screen.getByLabelText("mcp.fields.arguments"), "server.mjs");

    expect(screen.getByText("node server.mjs")).toBeTruthy();
    const save = screen.getByRole("button", { name: "mcp.save" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "mcp.commandApproval" }));
    expect(save.hasAttribute("disabled")).toBe(false);
    await userEvent.click(save);

    expect(host.upsertMcpConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "calendar",
        commandApproved: true,
        transport: expect.objectContaining({
          kind: "stdio",
          command: "node",
          args: ["server.mjs"],
        }),
      }),
    );
  });
});
