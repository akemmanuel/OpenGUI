// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  workspace: {
    id: "remote",
    serverUrl: "https://host.test",
    authToken: "token",
    isLocal: false,
  } as Record<string, unknown> | null,
  client: {
    sharePrincipals: vi.fn(),
    sessionShares: vi.fn(),
    sessionViewLinks: vi.fn(),
    shareSession: vi.fn(),
    revokeSessionShare: vi.fn(),
    createSessionViewLink: vi.fn(),
    revokeSessionViewLink: vi.fn(),
  },
  copy: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock("@/hooks/use-agent-state", () => ({
  useWorkspaceState: () => ({ activeWorkspace: fixture.workspace }),
}));
vi.mock("./workspace-identity", () => ({
  identityWorkspaceIsLocalBypass: (workspace: any) => workspace.isLocal,
}));
vi.mock("./identity-client", () => ({ createIdentityClient: () => fixture.client }));
vi.mock("@/lib/browser", () => ({ copyTextToClipboard: fixture.copy }));
vi.mock("@/lib/notify", () => ({
  notifyUnknownError: fixture.notifyError,
  notifySuccess: fixture.notifySuccess,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const interpolation =
        typeof values?.title === "string"
          ? values.title
          : typeof values?.name === "string"
            ? values.name
            : null;
      return interpolation ? `${key}:${interpolation}` : key;
    },
    i18n: { language: "en" },
  }),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: any) => (
    <select
      aria-label="select"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: any) => <>{children}</>,
  SelectValue: ({ placeholder }: any) => <option value="">{placeholder}</option>,
}));

import {
  OPEN_SESSION_SHARE_EVENT,
  openSessionShareDialog,
  SessionShareDialog,
} from "./SessionShareDialog";

const defaults = () => {
  fixture.client.sharePrincipals.mockResolvedValue({
    teams: [{ id: "team-1", name: "Builders" }],
    users: [{ id: "user-1", name: "Ada" }],
  });
  fixture.client.sessionShares.mockResolvedValue([]);
  fixture.client.sessionViewLinks.mockResolvedValue([]);
  fixture.client.shareSession.mockResolvedValue(undefined);
  fixture.client.createSessionViewLink.mockResolvedValue({
    id: "link-1",
    token: "public-token",
    expiresAt: null,
  });
  fixture.copy.mockResolvedValue(undefined);
};

describe("SessionShareDialog", () => {
  beforeEach(() => {
    for (const method of Object.values(fixture.client)) method.mockReset();
    fixture.copy.mockReset();
    fixture.notifyError.mockReset();
    fixture.notifySuccess.mockReset();
    fixture.workspace = {
      id: "remote",
      serverUrl: "https://host.test",
      authToken: "token",
      isLocal: false,
    };
    defaults();
  });
  afterEach(cleanup);

  test("opens through the public event and offers valid roles for users and Teams", async () => {
    render(<SessionShareDialog />);
    openSessionShareDialog("s1", "Launch plan");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    await screen.findByRole("option", { name: /Builders/ });
    const principal = screen.getAllByRole("combobox")[0]!;
    const access = screen.getAllByRole("combobox")[1]!;
    await userEvent.selectOptions(principal, "user:user-1");
    expect(
      Array.from(access.querySelectorAll("option"), (option) => option.value).filter(Boolean),
    ).toEqual(["view", "admin"]);
    await userEvent.selectOptions(access, "admin");
    await userEvent.click(screen.getByRole("button", { name: /sessionShare.share/ }));
    await waitFor(() =>
      expect(fixture.client.shareSession).toHaveBeenCalledWith("s1", {
        granteeType: "user",
        granteeId: "user-1",
        role: "admin",
      }),
    );

    await userEvent.selectOptions(principal, "team:team-1");
    expect(
      Array.from(access.querySelectorAll("option"), (option) => option.value).filter(Boolean),
    ).toEqual(["view", "run", "admin"]);
    await userEvent.selectOptions(access, "run");
    await userEvent.click(screen.getByRole("button", { name: /sessionShare.share/ }));
    await waitFor(() =>
      expect(fixture.client.shareSession).toHaveBeenLastCalledWith("s1", {
        granteeType: "team",
        granteeId: "team-1",
        role: "run",
      }),
    );
  });

  test("shows existing access, revokes it, creates and copies a view-only link", async () => {
    fixture.client.sessionShares.mockResolvedValue([
      { granteeType: "user", granteeId: "user-1", role: "view" },
    ]);
    fixture.client.sessionViewLinks.mockResolvedValue([
      { id: "old-link", token: "old", expiresAt: null },
    ]);
    fixture.client.revokeSessionShare.mockResolvedValue(undefined);
    fixture.client.revokeSessionViewLink.mockResolvedValue(undefined);
    render(<SessionShareDialog />);
    fireEvent(
      window,
      new CustomEvent(OPEN_SESSION_SHARE_EVENT, { detail: { sessionId: "s1", title: "Shared" } }),
    );
    expect(await screen.findByText("Ada")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "sessionShare.revokeShare:Ada" }));
    expect(fixture.client.revokeSessionShare).toHaveBeenCalledWith("s1", "user", "user-1");
    await userEvent.click(screen.getByRole("button", { name: "sessionShare.createLink" }));
    const copy = await screen.findByRole("button", { name: "identity.copyLink" });
    await userEvent.click(copy);
    expect(fixture.copy).toHaveBeenCalledWith(expect.stringContaining("?view=public-token"));
    expect(fixture.notifySuccess).toHaveBeenCalledWith("identity.copied");
    await userEvent.click(
      screen.getAllByRole("button", { name: "sessionShare.revokeLink" }).at(-1)!,
    );
    expect(fixture.client.revokeSessionViewLink).toHaveBeenCalledWith("old-link");
  });

  test("keeps the latest Session during rapid opens and retries load errors", async () => {
    let resolveOld!: (value: unknown) => void;
    fixture.client.sharePrincipals
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce({ teams: [], users: [{ id: "new", name: "New principal" }] });
    render(<SessionShareDialog />);
    openSessionShareDialog("old", "Old");
    openSessionShareDialog("new", "New");
    expect(await screen.findByRole("option", { name: /New principal/ })).toBeTruthy();
    resolveOld({ teams: [], users: [{ id: "old", name: "Stale principal" }] });
    await waitFor(() => expect(screen.queryByText(/Stale principal/)).toBeNull());

    fixture.client.sharePrincipals
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ teams: [], users: [] });
    openSessionShareDialog("retry", "Retry");
    expect(await screen.findByRole("alert")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(fixture.client.sharePrincipals).toHaveBeenCalledTimes(4));
  });

  test("does not open without remote credentials and removes its event listener on unmount", () => {
    fixture.workspace = { id: "local", serverUrl: "http://local", isLocal: true };
    const view = render(<SessionShareDialog />);
    openSessionShareDialog("s1", "Private");
    expect(screen.queryByRole("dialog")).toBeNull();
    view.unmount();
    openSessionShareDialog("s2", "After unmount");
    expect(fixture.client.sharePrincipals).not.toHaveBeenCalled();
  });
});
