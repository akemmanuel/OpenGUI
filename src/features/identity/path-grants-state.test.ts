import { describe, expect, test } from "vite-plus/test";
import {
  appendPathGrant,
  pathGrantAdministrationEnabled,
  removePathGrant,
  replaceGrantAccess,
} from "./path-grants-state";

describe("path grant administration state", () => {
  test("only exposes controls after enforcement is ready", () => {
    const status = {
      revision: 1,
      restricted: false,
      foundationReady: true,
      enforcementReady: true,
    };
    expect(pathGrantAdministrationEnabled({ ...status, mode: "enforced" })).toBe(true);
    expect(pathGrantAdministrationEnabled({ ...status, mode: "disabled" })).toBe(false);
    expect(
      pathGrantAdministrationEnabled({ ...status, mode: "enforced", enforcementReady: false }),
    ).toBe(false);
  });

  test("builds a complete grant draft without mutating the canonical source", () => {
    const canonical = [{ root: "/srv/read", access: "read" as const }];
    const added = appendPathGrant(canonical, " /srv/write ");
    const changed = replaceGrantAccess(added, 1, "write");
    const removed = removePathGrant(changed, 0);

    expect(canonical).toEqual([{ root: "/srv/read", access: "read" }]);
    expect(removed).toEqual([{ root: "/srv/write", access: "write" }]);
  });
});
