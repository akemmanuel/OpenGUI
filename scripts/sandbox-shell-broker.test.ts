import { describe, expect, test } from "vitest";
import { sandboxDockerArguments } from "./sandbox-shell-broker.ts";

describe("sandbox shell broker", () => {
  test("mounts only effective grants and preserves access modes", () => {
    const args = sandboxDockerArguments({
      image: "shell-image",
      name: "call-1",
      projectDirectory: "/work/client/site",
      resolvConf: "/etc/resolv.conf",
      grants: [
        { root: "/work/client", access: "write" },
        { root: "/reference", access: "read" },
      ],
      command: "git status",
    });
    expect(args).toContain("type=bind,src=/work/client,dst=/work/client");
    expect(args).toContain("type=bind,src=/reference,dst=/reference,readonly");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain("/app/.opengui-data");
    expect(args.slice(-5)).toEqual([
      "/work/client/site",
      "shell-image",
      "/bin/sh",
      "-lc",
      "git status",
    ]);
  });
});
