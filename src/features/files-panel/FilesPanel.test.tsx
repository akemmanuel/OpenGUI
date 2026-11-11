// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  root: "/project",
  host: "first",
  mobile: false,
  electron: true,
  local: false,
  native: false,
  fileBrowser: vi.fn(),
  client: { list: vi.fn(), stat: vi.fn(), search: vi.fn(), readText: vi.fn(), download: vi.fn() },
}));
vi.mock("@/hooks/use-agent-state", () => ({
  useSessionState: () => ({
    sessions: [],
    activeSessionId: null,
    activeTargetDirectory: fixture.root,
  }),
  useWorkspaceState: () => ({
    activeWorkspaceId: fixture.host,
    attachmentBaseUrl: "https://host.test",
    isLocalWorkspace: fixture.local,
    supportsNativeDirectoryPicker: fixture.native,
  }),
}));
vi.mock("@/features/session-transcript/active-session-transcript-provider", () => ({
  useActiveTranscriptSnapshot: () => ({ scope: null, messages: [] }),
}));
vi.mock("./host-file-client", async (original) => ({
  ...(await original<typeof import("./host-file-client")>()),
  useHostFileClient: () => fixture.client,
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => fixture.mobile }));
vi.mock("@/shell/provider", () => ({
  useDesktopShell: () => ({
    runtime: { isElectron: fixture.electron },
    system: { openInFileBrowser: fixture.fileBrowser },
  }),
}));
vi.mock("@/lib/syntax-highlighter", () => ({ highlightCode: async () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { FilesPanel } from "./FilesPanel";
import { FilesPanelToggle } from "./FilesPanelControls";
import { FilesPanelProvider } from "./files-panel-context";

function Surface() {
  return (
    <FilesPanelProvider>
      <FilesPanelToggle />
      <MarkdownRenderer content="[Report](/project/report.txt:2)" />
      <FilesPanel />
    </FilesPanelProvider>
  );
}
beforeEach(() => {
  localStorage.clear();
  fixture.root = "/project";
  fixture.host = "first";
  fixture.mobile = false;
  fixture.electron = true;
  fixture.local = false;
  fixture.native = false;
  fixture.fileBrowser.mockResolvedValue(undefined);
  fixture.client.list.mockResolvedValue({
    path: "/project",
    entries: [{ name: "report.txt", path: "/project/report.txt", type: "file" }],
  });
  fixture.client.stat.mockImplementation(async (path: string) => ({
    path,
    name: path.split("/").pop(),
    size: 10,
    modifiedAt: 1,
    textEncoding: "utf-8",
  }));
  fixture.client.readText.mockResolvedValue("first\nsecond");
  fixture.client.search.mockResolvedValue(["nested/found.txt"]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("file chips read nothing until clicked, open on a line, and return to the project", async () => {
  render(<Surface />);
  expect(fixture.client.stat).not.toHaveBeenCalled();
  expect(fixture.client.list).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "filesPanel.openLink" }));
  await screen.findByText(/first/);
  expect(fixture.client.stat).toHaveBeenCalledWith("/project/report.txt", expect.any(AbortSignal));
  await userEvent.click(screen.getByRole("button", { name: "filesPanel.back" }));
  expect(await screen.findByRole("button", { name: "report.txt" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "filesPanel.forward" }));
  expect(await screen.findByText(/first/)).toBeTruthy();
});

test("searches names across the root and opens a nested result", async () => {
  render(<Surface />);
  await userEvent.click(screen.getByRole("button", { name: /filesPanel.toggle/ }));
  await userEvent.type(screen.getByRole("searchbox"), "found");
  await userEvent.click(await screen.findByRole("button", { name: /found.txt/ }));
  await waitFor(() =>
    expect(fixture.client.stat).toHaveBeenCalledWith(
      "/project/nested/found.txt",
      expect.any(AbortSignal),
    ),
  );
});

test("switching Host at the same path resets history without reopening the old file", async () => {
  const view = render(<Surface />);
  await userEvent.click(screen.getByRole("button", { name: "filesPanel.openLink" }));
  await screen.findByText(/first/);
  fixture.client.stat.mockClear();
  fixture.host = "second";
  view.rerender(<Surface />);
  expect(await screen.findByRole("button", { name: "report.txt" })).toBeTruthy();
  expect(fixture.client.stat).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: "filesPanel.back" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("a new project clears navigation and the shortcut toggles the panel", async () => {
  const view = render(<Surface />);
  fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true });
  await screen.findByRole("button", { name: "report.txt" });
  fixture.root = "/other";
  view.rerender(<Surface />);
  await waitFor(() =>
    expect(fixture.client.list).toHaveBeenCalledWith("/other", expect.any(AbortSignal)),
  );
  expect(
    (screen.getByRole("button", { name: "filesPanel.back" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true });
  expect(screen.queryByRole("complementary")).toBeNull();
});

test("a file link context menu opens its preview at the linked line without reading on right-click", async () => {
  render(<Surface />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "filesPanel.openLink" }));
  expect(fixture.client.stat).not.toHaveBeenCalled();
  expect(screen.queryByRole("complementary")).toBeNull();
  await userEvent.click(await screen.findByRole("menuitem", { name: "filesPanel.open" }));
  await screen.findByText(/first/);
  expect(fixture.client.stat).toHaveBeenCalledWith("/project/report.txt", expect.any(AbortSignal));
});

test.each([
  { electron: true, local: true, native: true, visible: true },
  { electron: false, local: true, native: true, visible: false },
  { electron: true, local: false, native: false, visible: false },
  { electron: true, local: true, native: false, visible: false },
])("file manager availability follows the current runtime and Host: %j", async (state) => {
  Object.assign(fixture, state);
  render(<Surface />);
  await userEvent.click(screen.getByRole("button", { name: /filesPanel.toggle/ }));
  fireEvent.contextMenu(await screen.findByRole("button", { name: "report.txt" }));
  await screen.findByRole("menuitem", { name: "filesPanel.open" });
  const fileManager = screen.queryByRole("menuitem", { name: "filesPanel.openInFileBrowser" });
  expect(Boolean(fileManager)).toBe(state.visible);
  if (fileManager) {
    await userEvent.click(fileManager);
    expect(fixture.fileBrowser).toHaveBeenCalledWith("/project", "");
    expect(fixture.client.stat).not.toHaveBeenCalled();
  }
});
