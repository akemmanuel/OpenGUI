import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { ShellWorkspacePolicy } from "@/runtime/shell-policy";
import type { Workspace } from "@/types/electron";
import { resolveWorkspacePresentation } from "./workspace-presentation";

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: "ws-1",
    name: "Test",
    serverUrl: "https://idunara.com",
    isLocal: false,
    projects: [],
    ...overrides,
  };
}

const desktopPolicy: ShellWorkspacePolicy = {
  shellKind: "desktop",
  supportsMultipleWorkspaces: true,
  localWorkspaceMode: "desktop-local",
  configuredWebWorkspace: null,
};

describe("resolveWorkspacePresentation", () => {
  test("additional workspace on desktop is not local and has no native picker", () => {
    const presentation = resolveWorkspacePresentation(
      workspace({ isLocal: false, serverUrl: "https://idunara.com" }),
      desktopPolicy,
    );

    expect(presentation.isLocalWorkspace).toBe(false);
    expect(presentation.supportsNativeDirectoryPicker).toBe(false);
    expect(presentation.activeBackendUrl).toBe("https://idunara.com");
    expect(presentation.attachmentBaseUrl).toBe("https://idunara.com");
  });

  test("local workspace on desktop enables native directory picker", () => {
    const presentation = resolveWorkspacePresentation(
      workspace({ id: "local", isLocal: true, serverUrl: "http://127.0.0.1:4096" }),
      desktopPolicy,
    );

    expect(presentation.isLocalWorkspace).toBe(true);
    expect(presentation.supportsNativeDirectoryPicker).toBe(true);
    expect(presentation.attachmentBaseUrl).toBe(null);
  });

  test("null workspace is treated as non-local", () => {
    const presentation = resolveWorkspacePresentation(null, desktopPolicy);

    expect(presentation.isLocalWorkspace).toBe(false);
    expect(presentation.supportsNativeDirectoryPicker).toBe(false);
  });
});
