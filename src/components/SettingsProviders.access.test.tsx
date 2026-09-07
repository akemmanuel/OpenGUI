// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vite-plus/test";
const f = vi.hoisted(() => ({
  grants: [] as any[],
  replace: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({ refreshProviders: async () => {} }),
}));
vi.mock("@/features/identity/identity-actor-context", () => ({
  useIdentityActor: () => ({ type: "user", id: "owner", role: "owner" }),
}));
vi.mock("@/features/identity/workspace-identity", () => ({
  getIdentityWorkspace: () => ({ serverUrl: "http://localhost", authToken: "test" }),
}));
vi.mock("@/features/identity/identity-client", () => ({
  createIdentityClient: () => ({
    modelPolicy: async () => ({
      host: { allowByok: true, allowByos: true },
      team: { allowByok: true, allowByos: true },
    }),
    members: async () => [
      { id: "alice", username: "Alice", role: "member" },
      { id: "bob", username: "Bob", role: "member" },
    ],
    teams: async () => [
      {
        id: "host_default",
        name: "Everyone",
        memberIds: ["alice", "bob"],
        allowByok: true,
        allowByos: true,
      },
    ],
    modelOfferingEntitlements: async () => f.grants,
    replaceModelOfferingEntitlements: (...args: any[]) => f.replace(...args),
  }),
}));
vi.mock("@/protocol/host-client", () => ({
  createHostClient: () => ({
    listModelConnections: async () => [],
    listModelOfferings: async () => [{ id: "company", displayName: "Company model" }],
    codexAuthStatus: async () => ({ connected: false, pending: null }),
    subscriptionAuthStatus: async () => ({ connected: false, pending: null }),
  }),
}));
import { SettingsProviders } from "./SettingsProviders";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
test("keeps failed access changes for retry and cancel restores saved grants", async () => {
  f.grants = [];
  f.replace.mockRejectedValueOnce(new Error("offline"));
  f.replace.mockImplementation(async (_id, grants) => {
    f.grants = grants;
    return grants;
  });
  render(<SettingsProviders />);
  await userEvent.click(await screen.findByRole("button", { name: "access.manage" }));
  await userEvent.click(screen.getByRole("switch", { name: "Alice" }));
  await userEvent.click(screen.getByRole("button", { name: "access.save" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Alice" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "access.save" }));
  await screen.findByText("access.saved");
  await userEvent.click(screen.getByRole("switch", { name: "Bob" }));
  await userEvent.click(screen.getByRole("button", { name: "common.cancel" }));
  expect(screen.getByRole("switch", { name: "Bob" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("switch", { name: "Alice" }).getAttribute("aria-checked")).toBe("true");
});

test("does not lose the first person when access is changed before a save returns", async () => {
  f.grants = [];
  f.replace.mockImplementation(async (_id, grants) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    f.grants = grants;
    return grants;
  });
  const first = render(<SettingsProviders />);
  await userEvent.click(await screen.findByRole("button", { name: "access.manage" }));
  await userEvent.click(screen.getByRole("switch", { name: "Alice" }));
  await userEvent.click(screen.getByRole("switch", { name: "Bob" }));
  expect(f.replace).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "access.save" }));
  await waitFor(() => expect(screen.getByText("access.saved")).toBeTruthy());
  expect(f.replace).toHaveBeenCalledTimes(1);
  expect(f.replace.mock.calls[0]![1].map((g: any) => g.subjectId).sort()).toEqual(["alice", "bob"]);
  first.unmount();
  render(<SettingsProviders />);
  await userEvent.click(await screen.findByRole("button", { name: "access.manage" }));
  expect(screen.getByRole("switch", { name: "Alice" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("switch", { name: "Bob" }).getAttribute("aria-checked")).toBe("true");
});
