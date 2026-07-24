// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  canManage: true,
  nativePicker: false,
  openDirectory: vi.fn().mockResolvedValue("/native/chosen"),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  workspaces: [] as any[],
  workspace: {
    id: "remote",
    isLocal: false,
    serverUrl: "https://host.example",
    authToken: "secret-token",
  },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/components/ui/DialogShell", () => ({
  DialogShell: ({ open, title, children, footer }: any) =>
    open ? (
      <div role="dialog" aria-label={String(title)}>
        {children}
        <footer>{footer}</footer>
      </div>
    ) : null,
}));
vi.mock("@/hooks/workspace-guards", () => ({
  canManageProjects: () => fixture.canManage,
}));
vi.mock("@/lib/notify", () => ({
  notifyInfo: fixture.notifyInfo,
  notifyUnknownError: fixture.notifyError,
}));
vi.mock("@/shell/provider", () => ({
  useDesktopShell: () => ({ dialog: { openDirectory: fixture.openDirectory } }),
}));
vi.mock("@/shell/useRegisterMobileBackHandler", () => ({
  useRegisterMobileBackHandler: vi.fn(),
}));
vi.mock("@/hooks/use-agent-state", () => ({
  useWorkspaceState: () => ({
    activeWorkspace: fixture.workspace,
    activeWorkspaceId: "remote",
    workspaces: fixture.workspaces,
    workspaceServerUrl: fixture.workspace.serverUrl,
    workspaceDirectory: "/srv",
    supportsNativeDirectoryPicker: fixture.nativePicker,
  }),
}));

import { ProjectPathDialog, requestProjectPath } from "./ProjectPathDialog";

function listing(path = "/srv") {
  return {
    ok: true,
    value: {
      path,
      parent: "/",
      roots: ["/"],
      entries: [
        { name: "Alpha", path: `${path}/Alpha`, type: "dir" },
        { name: "Beta", path: `${path}/Beta`, type: "dir" },
      ],
    },
  };
}

describe("ProjectPathDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.canManage = true;
    fixture.nativePicker = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: string | URL | Request) => {
        const inputUrl =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        const requestedPath = new URL(inputUrl).searchParams.get("path") ?? "/srv";
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(listing(requestedPath)),
        };
      }),
    );
  });
  afterEach(cleanup);

  test("browses authenticated Host folders, filters them, and opens the selection", async () => {
    render(<ProjectPathDialog />);
    const result = requestProjectPath("/srv");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    const requestedUrl = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
    expect(requestedUrl).toContain("https://host.example/api/fs/list?path=%2Fsrv");
    expect((options?.headers as Headers | undefined)?.get("authorization")).toBe(
      "Bearer secret-token",
    );

    const search = screen.getByPlaceholderText("projectPath.searchFolders");
    await userEvent.type(search, "bet");
    expect(screen.queryByText("Alpha")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Beta" }));
    await waitFor(() =>
      expect(screen.getByTitle("projectPath.editPath").textContent).toContain("/srv/Beta"),
    );
    await userEvent.click(screen.getByRole("button", { name: "projectPath.openProject" }));
    await expect(result).resolves.toBe("/srv/Beta");
  });

  test("shows empty search feedback and lets the user clear the filter", async () => {
    render(<ProjectPathDialog />);
    void requestProjectPath();
    const search = await screen.findByPlaceholderText("projectPath.searchFolders");
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
    await userEvent.type(search, "nothing");
    expect(screen.getByText("projectPath.noMatchingFolders")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "projectPath.clearSearch" }));
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  test("denies Project selection before opening for read-only workspace access", async () => {
    fixture.canManage = false;
    render(<ProjectPathDialog />);
    await expect(requestProjectPath()).resolves.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fixture.notifyInfo).toHaveBeenCalledWith("workspace.requiredBeforeProject");
  });

  test("reports malformed server responses and remains cancellable", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "not-json",
    } as Response);
    render(<ProjectPathDialog />);
    const result = requestProjectPath();
    await waitFor(() => expect(fixture.notifyError).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    await expect(result).resolves.toBeNull();
  });
});
