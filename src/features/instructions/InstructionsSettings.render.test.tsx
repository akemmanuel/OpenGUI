// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  actor: { type: "local", id: "local", role: "owner" } as {
    type: "local" | "user";
    id: string;
    role: "owner" | "admin" | "member" | "viewer";
  },
  host: {
    getCustomInstructions: vi.fn(async () => ""),
    setCustomInstructions: vi.fn(async (text: string) => text.trim()),
    getPersonalInstructions: vi.fn(async () => "My preferences"),
    setPersonalInstructions: vi.fn(async (text: string) => text.trim()),
    listProjects: vi.fn(async () => [
      { name: "Repo", directory: "/repo" },
      { name: "Other", directory: "/other" },
    ]),
    getProjectInstructions: vi.fn(async (directory: string) => ({
      directory,
      text: "Shared repo rules",
      canEdit: true,
      canManage: true,
      teams: [{ id: "frontend", name: "Frontend", allowed: false }],
    })),
    setProjectInstructions: vi.fn(async (_directory: string, text: string) => text.trim()),
    setProjectInstructionEditor: vi.fn(async () => {}),
  },
  notifySuccess: vi.fn(),
  notifyUnknownError: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/identity/identity-actor-context", () => ({
  useIdentityActor: () => fixture.actor,
}));
vi.mock("@/features/identity/workspace-identity", () => ({
  getIdentityWorkspace: () => ({ serverUrl: "https://host.example", authToken: "token" }),
  identityWorkspaceIsLocalBypass: () => fixture.actor.type === "local",
}));
vi.mock("@/protocol/host-client", () => ({ createHostClient: () => fixture.host }));
vi.mock("@/lib/notify", () => ({
  notifySuccess: fixture.notifySuccess,
  notifyUnknownError: fixture.notifyUnknownError,
}));

import { InstructionsSettings } from "./InstructionsSettings";

describe("InstructionsSettings", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    fixture.actor = { type: "local", id: "local", role: "owner" };
    fixture.host.getCustomInstructions.mockResolvedValue("");
    fixture.host.setCustomInstructions.mockImplementation(async (text: string) => text.trim());
    fixture.host.getProjectInstructions.mockImplementation(async (directory: string) => ({
      directory,
      text: "Shared repo rules",
      canEdit: true,
      canManage: true,
      teams: [{ id: "frontend", name: "Frontend", allowed: false }],
    }));
  });

  test("loads host-wide instructions and saves a trimmed draft", async () => {
    fixture.host.getCustomInstructions.mockResolvedValue("Always reply in Spanish.");
    render(<InstructionsSettings />);

    const editor = await screen.findByLabelText("settings.instructions.label");
    expect((editor as HTMLTextAreaElement).value).toBe("Always reply in Spanish.");

    await userEvent.clear(editor);
    await userEvent.type(editor, " Prefer British spelling. ");
    await userEvent.click(screen.getByRole("button", { name: "settings.instructions.save" }));

    await waitFor(() =>
      expect(fixture.host.setCustomInstructions).toHaveBeenCalledWith(" Prefer British spelling. "),
    );
    expect(fixture.notifySuccess).toHaveBeenCalledWith("settings.instructions.saved");
    expect((editor as HTMLTextAreaElement).value).toBe("Prefer British spelling.");
  });

  test("edits private personal preferences independently from host text", async () => {
    render(<InstructionsSettings />);
    await screen.findByLabelText("settings.instructions.label");
    await userEvent.click(
      screen.getByRole("button", { name: "settings.instructions.scope.personal" }),
    );
    const editor = await screen.findByLabelText("settings.instructions.label");
    expect((editor as HTMLTextAreaElement).value).toBe("My preferences");
    await userEvent.clear(editor);
    await userEvent.type(editor, "Keep it short");
    await userEvent.click(screen.getByRole("button", { name: "settings.instructions.save" }));
    await waitFor(() =>
      expect(fixture.host.setPersonalInstructions).toHaveBeenCalledWith("Keep it short"),
    );
    expect(fixture.host.setCustomInstructions).not.toHaveBeenCalled();
  });

  test("saves shared project text and manages team editor permissions", async () => {
    render(<InstructionsSettings />);
    await screen.findByLabelText("settings.instructions.label");
    await userEvent.click(
      screen.getByRole("button", { name: "settings.instructions.scope.project" }),
    );
    const editor = await screen.findByLabelText("settings.instructions.label");
    expect((editor as HTMLTextAreaElement).value).toBe("Shared repo rules");
    await userEvent.clear(editor);
    await userEvent.type(editor, "Use the repo test suite");
    await userEvent.click(screen.getByRole("button", { name: "settings.instructions.save" }));
    await waitFor(() =>
      expect(fixture.host.setProjectInstructions).toHaveBeenCalledWith(
        "/repo",
        "Use the repo test suite",
      ),
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Frontend" }));
    await waitFor(() =>
      expect(fixture.host.setProjectInstructionEditor).toHaveBeenCalledWith(
        "/repo",
        "frontend",
        true,
      ),
    );
    expect((screen.getByRole("checkbox", { name: "Frontend" }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  test("project permissions come from the server and dirty drafts survive a cancelled scope change", async () => {
    fixture.actor = { type: "user", id: "member", role: "member" };
    fixture.host.getProjectInstructions.mockResolvedValue({
      directory: "/repo",
      text: "Shared repo rules",
      canEdit: false,
      canManage: false,
      teams: [],
    });
    render(<InstructionsSettings />);
    await screen.findByLabelText("settings.instructions.label");
    await userEvent.click(
      screen.getByRole("button", { name: "settings.instructions.scope.project" }),
    );
    const editor = await screen.findByLabelText("settings.instructions.label");
    expect((editor as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole("checkbox")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "settings.instructions.scope.personal" }),
    );
    const personal = await screen.findByLabelText("settings.instructions.label");
    await userEvent.type(personal, " unsaved");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await userEvent.click(screen.getByRole("button", { name: "settings.instructions.scope.host" }));
    expect(confirm).toHaveBeenCalled();
    expect(
      (screen.getByLabelText("settings.instructions.label") as HTMLTextAreaElement).value,
    ).toContain("unsaved");
    vi.unstubAllGlobals();
  });

  test("failed saves preserve the project draft", async () => {
    fixture.host.setProjectInstructions.mockRejectedValueOnce(new Error("Permission revoked"));
    render(<InstructionsSettings />);
    await screen.findByLabelText("settings.instructions.label");
    await userEvent.click(
      screen.getByRole("button", { name: "settings.instructions.scope.project" }),
    );
    const editor = await screen.findByLabelText("settings.instructions.label");
    await userEvent.type(editor, " unsaved");
    await userEvent.click(screen.getByRole("button", { name: "settings.instructions.save" }));
    await waitFor(() => expect(fixture.notifyUnknownError).toHaveBeenCalled());
    expect((editor as HTMLTextAreaElement).value).toContain("unsaved");
    expect(
      (screen.getByRole("button", { name: "settings.instructions.save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test("failed personal saves preserve the draft", async () => {
    fixture.host.setPersonalInstructions.mockRejectedValueOnce(new Error("Host unreachable"));
    render(<InstructionsSettings />);
    await screen.findByLabelText("settings.instructions.label");
    await userEvent.click(
      screen.getByRole("button", { name: "settings.instructions.scope.personal" }),
    );
    const editor = await screen.findByLabelText("settings.instructions.label");
    await userEvent.type(editor, " unsaved");
    await userEvent.click(screen.getByRole("button", { name: "settings.instructions.save" }));
    await waitFor(() => expect(fixture.notifyUnknownError).toHaveBeenCalled());
    expect((editor as HTMLTextAreaElement).value).toContain("unsaved");
    expect(
      (screen.getByRole("button", { name: "settings.instructions.save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test("lets members read instructions but not edit them", async () => {
    fixture.actor = { type: "user", id: "member", role: "member" };
    fixture.host.getCustomInstructions.mockResolvedValue("Always reply in Spanish.");
    render(<InstructionsSettings />);

    const editor = await screen.findByLabelText("settings.instructions.label");
    expect((editor as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "settings.instructions.save" })).toBeNull();
    expect(screen.getByText("settings.instructions.readOnly")).toBeTruthy();
  });
});
