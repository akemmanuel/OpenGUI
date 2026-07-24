import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { IdentityService } from "./identity.ts";

const services: IdentityService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.database.close();
});

function service() {
  const value = new IdentityService({
    database: new DatabaseSync(":memory:"),
    secret: "session-reconciliation-test-secret-at-least-32-characters",
  });
  services.push(value);
  return value;
}

describe("Session access metadata reconciliation", () => {
  test("fails closed when a non-local Session has no owner metadata", async () => {
    const identity = service();
    await identity.ready;

    await expect(
      identity.authorizeSessionAction(
        "orphan",
        { type: "user", id: "unknown", displayName: "Unknown", role: "member" },
        "view",
      ),
    ).rejects.toMatchObject({ code: "SESSION_FORBIDDEN", status: 404 });
  });

  test("atomically removes stale metadata and returns only Sessions with owners", async () => {
    const identity = service();
    await identity.ready;
    const actor = { type: "user" as const, id: "ada", displayName: "Ada", role: "owner" as const };
    await identity.recordSessionOwner("live", actor);
    await identity.recordSessionOwner("stale", actor);

    await expect(identity.reconcileSessionAccess(["live", "orphan"])).resolves.toEqual(["live"]);
    expect(
      identity.database
        .prepare("SELECT session_id FROM host_session_access ORDER BY session_id")
        .all(),
    ).toEqual([{ session_id: "live" }]);
  });
});
