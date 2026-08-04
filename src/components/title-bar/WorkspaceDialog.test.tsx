// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { WorkspaceDialog } from "./WorkspaceDialog";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const identity = vi.hoisted(() => ({
  health: vi.fn(),
  policy: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  setup: vi.fn(),
  register: vi.fn(),
}));
vi.mock("@/features/identity/identity-client", () => ({
  createIdentityClient: () => identity,
  IdentityRequestError: class IdentityRequestError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
afterEach(() => {
  cleanup();
  for (const method of Object.values(identity)) method.mockReset();
});

const initial = {
  name: "Remote",
  serverUrl: "https://host.test",
  authToken: "secret",
  isLocal: false,
};

describe("WorkspaceDialog", () => {
  test("validates, trims, and submits a new Workspace from the keyboard", async () => {
    identity.health.mockResolvedValue({ authRequired: false, identity: "ready" });
    const submit = vi.fn();
    const change = vi.fn();
    render(
      <WorkspaceDialog
        open
        mode="add"
        initial={{ ...initial, name: "", serverUrl: "https://", authToken: "" }}
        onSubmit={submit}
        onOpenChange={change}
      />,
    );
    const save = screen.getByRole("button", { name: /workspace.continue/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("workspace.name"), "  Team  ");
    await userEvent.clear(screen.getByLabelText("workspace.backendUrl"));
    await userEvent.type(screen.getByLabelText("workspace.backendUrl"), "  https://remote.test  ");
    await userEvent.type(screen.getByLabelText(/workspace.accessToken/), " token {Enter}");
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        name: "Team",
        serverUrl: "https://remote.test",
        authToken: "token",
      }),
    );
    expect(change).toHaveBeenCalledWith(false);
  });

  test("keeps the current app visible while signing in, then adds the authenticated Workspace", async () => {
    identity.health.mockResolvedValue({ authRequired: true, identity: "ready" });
    identity.policy.mockResolvedValue({ registrationMode: "invite_only" });
    identity.login.mockResolvedValue({ token: "session-token" });
    const submit = vi.fn();
    const change = vi.fn();
    render(
      <WorkspaceDialog
        open
        mode="add"
        initial={{ ...initial, authToken: "" }}
        onSubmit={submit}
        onOpenChange={change}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /workspace.continue/ }));
    expect(await screen.findByText("workspace.signInTitle")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalledWith(false);

    await userEvent.type(screen.getByLabelText("identity.username"), "ada");
    await userEvent.type(screen.getByLabelText("identity.password"), "password-123");
    await userEvent.click(screen.getByRole("button", { name: /workspace.signInAndAdd/ }));

    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        name: "Remote",
        serverUrl: "https://host.test",
        authToken: "session-token",
      }),
    );
    expect(change).toHaveBeenCalledWith(false);
  });

  test("resets rapidly changed initial values whenever the dialog reopens", () => {
    const props = { mode: "edit" as const, onSubmit: vi.fn(), onOpenChange: vi.fn() };
    const view = render(<WorkspaceDialog open {...props} initial={initial} />);
    expect((screen.getByLabelText("workspace.name") as HTMLInputElement).value).toBe("Remote");
    view.rerender(<WorkspaceDialog open={false} {...props} initial={initial} />);
    view.rerender(
      <WorkspaceDialog
        open
        {...props}
        initial={{ ...initial, name: "Other", authToken: "next" }}
      />,
    );
    expect((screen.getByLabelText("workspace.name") as HTMLInputElement).value).toBe("Other");
    expect((screen.getByLabelText(/workspace.accessToken/) as HTMLInputElement).value).toBe("next");
  });

  test("edits without changing the Host URL and protects the Local Workspace from removal", async () => {
    const submit = vi.fn();
    const remove = vi.fn();
    const view = render(
      <WorkspaceDialog
        open
        mode="edit"
        initial={{ ...initial, isLocal: true }}
        onSubmit={submit}
        onOpenChange={vi.fn()}
        onRemove={remove}
      />,
    );
    expect(screen.queryByRole("button", { name: "common.remove" })).toBeNull();
    await userEvent.clear(screen.getByLabelText("workspace.name"));
    await userEvent.type(screen.getByLabelText("workspace.name"), "Renamed");
    await userEvent.click(screen.getByRole("button", { name: "common.save" }));
    expect(submit).toHaveBeenCalledWith({
      name: "Renamed",
      serverUrl: "https://host.test",
      authToken: "secret",
    });

    view.rerender(
      <WorkspaceDialog
        open
        mode="edit"
        initial={initial}
        onSubmit={submit}
        onOpenChange={vi.fn()}
        onRemove={remove}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "common.remove" }));
    expect(remove).toHaveBeenCalledOnce();
  });
});
