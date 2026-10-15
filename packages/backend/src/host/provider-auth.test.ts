import { describe, expect, test } from "vite-plus/test";
import { KeyedSerialLock } from "../effect/serial-lock.ts";
import {
  createHostCredentialStore,
  migrateLegacyProviderCredentials,
  ProviderLogins,
  type ProviderCredentials,
} from "./provider-auth.ts";

function memoryStore(ownerId?: string, initial: ProviderCredentials = {}) {
  let credentials = initial;
  const store = createHostCredentialStore({
    ownerId,
    current: () => credentials,
    update: async (change) => {
      credentials = change(credentials);
    },
    lock: new KeyedSerialLock(),
  });
  return { store, credentials: () => credentials };
}

describe("pi provider credentials", () => {
  test("keeps Host and personal credentials apart under stable connection ids", async () => {
    const shared = memoryStore();
    await shared.store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 1,
    }));
    await shared.store.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant" }));
    expect(Object.keys(shared.credentials())).toEqual(["chatgpt-codex", "anthropic"]);

    const personal = memoryStore("user-1", shared.credentials());
    expect(await personal.store.read("anthropic")).toBeUndefined();
    await personal.store.modify("anthropic", async () => ({ type: "api_key", key: "sk-mine" }));
    const [personalId] = Object.keys(personal.credentials()).filter((id) =>
      id.startsWith("personal-"),
    );
    expect(personal.credentials()[personalId!]).toEqual({
      providerId: "anthropic",
      ownerId: "user-1",
      credential: { type: "api_key", key: "sk-mine" },
    });
    // A later write reuses the same personal connection id.
    await personal.store.modify("anthropic", async () => ({ type: "api_key", key: "sk-new" }));
    expect(Object.keys(personal.credentials()).filter((id) => id.startsWith("personal-"))).toEqual([
      personalId,
    ]);
    expect(await personal.store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
    await personal.store.delete("anthropic");
    expect(personal.credentials()[personalId!]).toBeUndefined();
    expect(personal.credentials().anthropic?.credential).toEqual({
      type: "api_key",
      key: "sk-ant",
    });
  });

  test("folds first-party Codex, xAI and OpenCode credentials into pi providers", () => {
    const tokens = (access: string) => ({
      accessToken: access,
      refreshToken: `${access}-refresh`,
      expiresAt: 42,
      accountId: "account",
    });
    const migrated = migrateLegacyProviderCredentials({
      providerCredentials: {},
      apiKeys: { "xai-api": "xai-key", "opencode-zen": "zen-key", custom: "custom-key" },
      modelConnections: [{ id: "opencode-zen" }, { id: "opencode-go" }, { id: "custom" }],
      codexTokens: tokens("codex"),
      subscriptionTokens: { xai: tokens("grok") },
      personalCodexTokens: { "user-1": { connectionId: "personal-a", tokens: tokens("mine") } },
      personalSubscriptionTokens: {
        "user-2": { xai: { connectionId: "personal-b", tokens: tokens("theirs") } },
      },
    });
    expect(migrated.providerCredentials).toEqual({
      "chatgpt-codex": {
        providerId: "openai-codex",
        credential: {
          type: "oauth",
          access: "codex",
          refresh: "codex-refresh",
          expires: 42,
          accountId: "account",
        },
      },
      "personal-a": expect.objectContaining({ providerId: "openai-codex", ownerId: "user-1" }),
      // The documented API key wins over the experimental subscription proxy.
      xai: { providerId: "xai", credential: { type: "api_key", key: "xai-key" } },
      "personal-b": expect.objectContaining({ providerId: "xai", ownerId: "user-2" }),
      "opencode-zen": { providerId: "opencode", credential: { type: "api_key", key: "zen-key" } },
      "opencode-go": { providerId: "opencode-go", credential: { type: "api_key" } },
    });
    expect(migrated.apiKeys).toEqual({ custom: "custom-key" });
    expect(migrated.modelConnections).toEqual([{ id: "custom" }]);
  });
});

describe("provider sign-in sessions", () => {
  test("surfaces pi prompts and events, then completes with the stored connection", async () => {
    const logins = new ProviderLogins();
    let reachedEnd = false;
    logins.begin("key", { providerId: "openai-codex", method: "oauth" }, async (interaction) => {
      const method = await interaction.prompt({
        type: "select",
        message: "Select login method",
        options: [{ id: "device", label: "Device code" }],
      });
      expect(method).toBe("device");
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      const code = await interaction.prompt({ type: "manual_code", message: "Paste code" });
      expect(code).toBe("pasted");
      reachedEnd = true;
      return "chatgpt-codex";
    });
    await Promise.resolve();
    const first = logins.status("key")!;
    expect(first).toMatchObject({ state: "awaiting_input", prompt: { type: "select" } });
    await logins.respond("key", first.prompt!.id, "device");
    const second = logins.status("key")!;
    expect(second.events).toEqual([
      expect.objectContaining({ type: "device_code", userCode: "ABCD-1234" }),
    ]);
    expect(second.prompt).toMatchObject({ type: "manual_code" });
    await expect(logins.respond("key", first.prompt!.id, "stale")).rejects.toThrow(
      "no longer waiting",
    );
    const done = await logins.respond("key", second.prompt!.id, "pasted");
    expect(reachedEnd).toBe(true);
    expect(done).toMatchObject({ state: "succeeded", connectionId: "chatgpt-codex" });
    expect(done.prompt).toBeUndefined();
  });

  test("cancels a waiting flow and reports failures without secrets", async () => {
    const logins = new ProviderLogins();
    let aborted = false;
    logins.begin("cancel", { providerId: "anthropic", method: "api_key" }, async (interaction) => {
      try {
        await interaction.prompt({ type: "secret", message: "Enter key" });
      } finally {
        aborted = interaction.signal?.aborted ?? false;
      }
      return undefined;
    });
    await Promise.resolve();
    expect(logins.cancel("cancel")).toMatchObject({ state: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(true);
    expect(logins.status("cancel")).toBeUndefined();

    logins.begin("fail", { providerId: "groq", method: "api_key" }, async () => {
      throw new Error("rejected Bearer gsk-secret-value");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = logins.status("fail")!;
    expect(failed.state).toBe("failed");
    expect(failed.error).not.toContain("gsk-secret-value");
  });
});
