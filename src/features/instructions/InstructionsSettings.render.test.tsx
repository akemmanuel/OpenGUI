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
