// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
const fixture = vi.hoisted(() => ({
  actor: { type: "user", displayName: "Alex", id: "user", role: "member" },
  workspace: { id: "host", name: "Test Host", serverUrl: "http://host", authToken: "old-token" },
  me: vi.fn(),
  updateProfile: vi.fn(),
  changePassword: vi.fn(),
  requestEmailChange: vi.fn(),
  emailChangeStatus: vi.fn(),
  cancelEmailChange: vi.fn(),
  logout: vi.fn(),
  persist: vi.fn(),
  announce: vi.fn(),
}));
vi.mock("@/hooks/use-agent-state", () => ({
  useWorkspaceState: () => ({ activeWorkspace: fixture.workspace }),
}));
vi.mock("./identity-actor-context", () => ({ useIdentityActor: () => fixture.actor }));
vi.mock("./workspace-identity", () => ({
  logoutActiveWorkspaceIdentity: fixture.logout,
  persistWorkspaceIdentityToken: fixture.persist,
  announceIdentityWorkspaceChange: fixture.announce,
}));
vi.mock("./identity-client", async (original) => ({
  ...(await original<typeof import("./identity-client")>()),
  createIdentityClient: () => ({
    me: fixture.me,
    updateProfile: fixture.updateProfile,
    changePassword: fixture.changePassword,
    requestEmailChange: fixture.requestEmailChange,
    emailChangeStatus: fixture.emailChangeStatus,
    cancelEmailChange: fixture.cancelEmailChange,
  }),
}));
import { ProfileMenu } from "./ProfileMenu";
import { IdentityRequestError } from "./identity-client";
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  fixture.actor.type = "user";
  fixture.me.mockResolvedValue({
    user: { id: "user", name: "Alex", username: "alex_user", email: "alex@example.com" },
    actor: fixture.actor,
  });
  fixture.updateProfile.mockResolvedValue(undefined);
  fixture.changePassword.mockResolvedValue({ token: "new-token" });
  fixture.emailChangeStatus.mockResolvedValue({ pending: null });
  fixture.cancelEmailChange.mockResolvedValue({ cancelled: true });
});
async function openMenu() {
  render(<ProfileMenu />);
  await waitFor(() => expect(fixture.me).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: "account.openProfile" }));
}
test("hides account controls for Local", () => {
  fixture.actor.type = "local";
  render(<ProfileMenu />);
  expect(screen.queryByRole("button")).toBeNull();
});
test("edits display name while keeping username and email read-only", async () => {
  await openMenu();
  await userEvent.click(screen.getByRole("menuitem", { name: "account.editProfile" }));
  expect((screen.getByLabelText("identity.username") as HTMLInputElement).readOnly).toBe(true);
  expect((screen.getByLabelText("identity.email") as HTMLInputElement).readOnly).toBe(true);
  await userEvent.clear(screen.getByLabelText("account.displayName"));
  await userEvent.type(screen.getByLabelText("account.displayName"), "Alex Smith");
  await userEvent.click(screen.getByRole("button", { name: "common.save" }));
  expect(fixture.updateProfile).toHaveBeenCalledWith("Alex Smith");
  expect(fixture.announce).toHaveBeenCalledOnce();
});
test("validates matching passwords, handles wrong current password, and persists rotated token", async () => {
  await openMenu();
  await userEvent.click(screen.getByRole("menuitem", { name: "account.changePassword" }));
  await userEvent.type(screen.getByLabelText("account.currentPassword"), "wrong password");
  await userEvent.type(screen.getByLabelText("account.newPassword"), "new secure password");
  await userEvent.type(screen.getByLabelText("identity.confirmPassword"), "different password");
  await userEvent.click(screen.getByRole("button", { name: "common.save" }));
  expect(screen.getByRole("alert").textContent).toBe("identity.passwordMismatch");
  expect(fixture.changePassword).not.toHaveBeenCalled();
  await userEvent.clear(screen.getByLabelText("identity.confirmPassword"));
  await userEvent.type(screen.getByLabelText("identity.confirmPassword"), "new secure password");
  fixture.changePassword.mockRejectedValueOnce(
    new IdentityRequestError("Invalid password", 400, "INVALID_PASSWORD"),
  );
  await userEvent.click(screen.getByRole("button", { name: "common.save" }));
  expect(screen.getByRole("alert").textContent).toBe("account.wrongPassword");
  await userEvent.click(screen.getByRole("button", { name: "account.showPasswords" }));
  expect((screen.getByLabelText("account.newPassword") as HTMLInputElement).type).toBe("text");
  await userEvent.click(screen.getByRole("button", { name: "common.save" }));
  expect(fixture.persist).toHaveBeenCalledWith("host", "new-token");
});
test("offers logout directly from the menu", async () => {
  await openMenu();
  await userEvent.click(screen.getByRole("menuitem", { name: "identity.signOut" }));
  expect(fixture.logout).toHaveBeenCalledOnce();
});
test("requests email change with reauthentication and preserves the draft on failure", async () => {
  await openMenu();
  await userEvent.click(screen.getByRole("menuitem", { name: "account.changeEmail" }));
  expect((screen.getByLabelText("account.currentEmail") as HTMLInputElement).readOnly).toBe(true);
  expect((screen.getByLabelText("account.currentEmail") as HTMLInputElement).value).toBe(
    "alex@example.com",
  );
  await userEvent.type(screen.getByLabelText("account.newEmail"), "new-address@example.com");
  await userEvent.type(screen.getByLabelText("account.currentPassword"), "wrong password");
  fixture.requestEmailChange.mockRejectedValueOnce(
    new IdentityRequestError("Invalid password", 400, "INVALID_PASSWORD"),
  );
  await userEvent.click(screen.getByRole("button", { name: "common.save" }));
  expect(fixture.requestEmailChange).toHaveBeenCalledWith(
    {
      newEmail: "new-address@example.com",
      currentPassword: "wrong password",
    },
    expect.any(String),
  );
  expect(screen.getByRole("alert").textContent).toBe("account.wrongPassword");
  // The draft address survives the failure for retry.
  expect((screen.getByLabelText("account.newEmail") as HTMLInputElement).value).toBe(
    "new-address@example.com",
  );
});
test("shows the pending change and cancels it", async () => {
  fixture.emailChangeStatus.mockResolvedValueOnce({
    pending: { email: "new-address@example.com", expiresAt: Date.now() + 1000 },
  });
  fixture.requestEmailChange.mockResolvedValueOnce({ sent: true, expiresAt: Date.now() + 1000 });
  await openMenu();
  await userEvent.click(screen.getByRole("menuitem", { name: "account.changeEmail" }));
  await waitFor(() =>
    expect(screen.getByText("account.emailPendingNotice", { exact: false })).toBeTruthy(),
  );
  await userEvent.type(screen.getByLabelText("account.newEmail"), "new-address@example.com");
  await userEvent.type(screen.getByLabelText("account.currentPassword"), "correct password");
  await userEvent.click(screen.getByRole("button", { name: "common.save" }));
  expect(fixture.requestEmailChange).toHaveBeenCalledWith(
    {
      newEmail: "new-address@example.com",
      currentPassword: "correct password",
    },
    expect.any(String),
  );
  await userEvent.click(screen.getByRole("button", { name: "account.emailCancelChange" }));
  expect(fixture.cancelEmailChange).toHaveBeenCalledOnce();
});
