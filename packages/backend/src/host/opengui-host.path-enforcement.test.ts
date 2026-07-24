import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { DurableActor, ExecutionPolicyResolver } from "@opengui/harness";
import { createEffectivePathPolicy } from "../path-policy/path-policy.ts";
import { HostSessionNotFoundError, OpenGuiHost } from "./opengui-host.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("OpenGuiHost path enforcement", () => {
  test("mediates projects and every direct-ID Session operation through stored Project paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-host-enforcement-"));
    temporaryDirectories.push(root);
    const granted = join(root, "granted");
    const denied = join(root, "denied");
    const prefix = join(root, "granted-private");
    await Promise.all([mkdir(granted), mkdir(denied), mkdir(prefix)]);
    await symlink(denied, join(granted, "escape"), "dir");

    const owner: DurableActor = { type: "user", id: "owner", displayName: "Owner" };
    const member: DurableActor = { type: "user", id: "member", displayName: "Stale label" };
    const apiKey: DurableActor = { type: "api_key", id: "key", displayName: "Stale key" };
    let memberGrant: "none" | "read" | "write" = "none";
    let keyRevoked = false;
    const resolver: ExecutionPolicyResolver = async (actor) => {
      if (!actor || (actor.id === apiKey.id && keyRevoked)) throw new Error("Actor removed");
      const unrestricted = actor.id === owner.id;
      const access = actor.id === member.id ? memberGrant : "read";
      return createEffectivePathPolicy({
        revision: keyRevoked ? 3 : memberGrant === "none" ? 1 : 2,
        restricted: !unrestricted,
        allowedRoots: [root],
        grants: unrestricted || access === "none" ? [] : [{ root: granted, access }],
      });
    };
    const host = new OpenGuiHost(root, { resolveExecutionPolicy: resolver });
    await host.start();
    await host.upsertModelConnection({
      id: "test",
      label: "Test",
      baseUrl: "http://127.0.0.1/unused",
      modelIds: ["test"],
    });

    const hidden = await host.createSession(
      {
        projectDirectory: denied,
        model: { connectionId: "test", modelId: "test" },
        reasoning: "none",
      },
      owner,
    );
    expect(await host.listProjects(member)).toEqual([]);
    await expect(host.registerProject(granted, member)).rejects.toThrow("Path not authorized");
    await expect(host.listSessions(granted, member)).rejects.toThrow("Path not authorized");
    await expect(
      host.createSession(
        {
          projectDirectory: granted,
          model: { connectionId: "test", modelId: "test" },
          reasoning: "none",
        },
        member,
      ),
    ).rejects.toThrow("Path not authorized");

    const deniedOperations = [
      () => host.readSession(hidden.id, member),
      () => host.renameSession(hidden.id, "rename", member),
      () => host.setModel(hidden.id, { connectionId: "test", modelId: "test" }, member),
      () => host.setReasoning(hidden.id, "low", member),
      () => host.prompt(hidden.id, { text: "prompt", actor: member }),
      () => host.updateFollowUp(hidden.id, "follow", { text: "update", actor: member }),
      () => host.reorderFollowUp(hidden.id, "follow", 0, member),
      () => host.removeFollowUp(hidden.id, "follow", member),
      () => host.sendFollowUpNow(hidden.id, "follow", member),
      () => host.abort(hidden.id, member),
      () => host.deleteSession(hidden.id, member),
    ];
    for (const operation of deniedOperations) {
      await expect(operation()).rejects.toBeInstanceOf(HostSessionNotFoundError);
    }

    memberGrant = "read";
    const visible = await host.createSession(
      {
        projectDirectory: granted,
        model: { connectionId: "test", modelId: "test" },
        reasoning: "none",
      },
      member,
    );
    expect((await host.listSessions(granted, member)).map((session) => session.id)).toContain(
      visible.id,
    );
    expect((await host.renameSession(visible.id, "Allowed", member)).title).toBe("Allowed");
    await expect(host.listSessions(prefix, member)).rejects.toThrow("Path not authorized");
    await expect(host.listSessions(join(granted, "escape"), member)).rejects.toThrow(
      "Path not authorized",
    );

    expect((await host.readSession(visible.id, apiKey)).id).toBe(visible.id);
    keyRevoked = true;
    await expect(host.readSession(visible.id, apiKey)).rejects.toBeInstanceOf(
      HostSessionNotFoundError,
    );
    expect((await host.readSession(hidden.id, owner)).id).toBe(hidden.id);
    await host.close();
  });
});
