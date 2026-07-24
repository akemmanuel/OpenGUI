import { describe, expect, it } from "vite-plus/test";
import {
  identityGateReducer,
  ownerSettingsVisibility,
  shouldBypassIdentity,
} from "./identity-state";

const readyHealth = {
  ok: true,
  version: "1.0.0",
  shell: "web",
  identity: "ready" as const,
  authRequired: true,
};

describe("identity gate state", () => {
  it("bypasses accounts only for Desktop Local", () => {
    expect(shouldBypassIdentity("desktop", true)).toBe(true);
    expect(shouldBypassIdentity("desktop", false)).toBe(false);
    expect(shouldBypassIdentity("web", true)).toBe(false);
    expect(shouldBypassIdentity("mobile", true)).toBe(false);
  });

  it("routes an empty remote Host to setup", () => {
    expect(
      identityGateReducer(
        { status: "checking" },
        { type: "health", health: { ...readyHealth, identity: "setup" }, hasToken: false },
      ),
    ).toEqual({ status: "setup", health: { ...readyHealth, identity: "setup" } });
  });

  it("requires login for a ready Host without a token", () => {
    expect(
      identityGateReducer(
        { status: "checking" },
        { type: "health", health: readyHealth, hasToken: false },
      ),
    ).toEqual({ status: "login", health: readyHealth });
  });

  it("waits for session verification when a token exists", () => {
    expect(
      identityGateReducer(
        { status: "checking" },
        { type: "health", health: readyHealth, hasToken: true },
      ),
    ).toEqual({ status: "checking" });
  });
});

describe("owner settings visibility", () => {
  it("members see neither owner administration tab", () => {
    expect(
      ownerSettingsVisibility(
        { type: "user", id: "member", displayName: "Member", role: "member" },
        false,
      ),
    ).toEqual({ providers: false, team: false });
  });

  it("only owner users see Team while Desktop Local keeps provider settings", () => {
    expect(
      ownerSettingsVisibility(
        { type: "user", id: "owner", displayName: "Owner", role: "owner" },
        false,
      ),
    ).toEqual({ providers: true, team: true });
    expect(ownerSettingsVisibility(null, true)).toEqual({ providers: true, team: false });
  });
});
