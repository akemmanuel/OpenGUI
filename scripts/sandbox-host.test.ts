import { readFile } from "node:fs/promises";
import { load } from "js-yaml";
import { describe, expect, test } from "vitest";

type ComposeService = {
  runtime?: string;
  privileged?: boolean;
  network_mode?: string;
  pid?: string;
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: Array<string | Record<string, unknown>>;
  secrets?: Array<string | { source?: string; target?: string; mode?: string }>;
  cap_drop?: string[];
  security_opt?: string[];
  pids_limit?: number;
  mem_limit?: string;
  cpus?: number;
};

type ComposeDocument = {
  services?: Record<string, ComposeService>;
  secrets?: Record<string, { file?: string }>;
};

async function sandboxCompose() {
  const source = await readFile(new URL("../docker/sandbox/compose.yml", import.meta.url), "utf8");
  return load(source) as ComposeDocument;
}

describe("sandboxed Remote Host deployment contract", () => {
  test("runs OpenGUI in a bounded gVisor environment with only its workspace mounted", async () => {
    const compose = await sandboxCompose();
    const service = compose.services?.opengui;

    expect(service).toBeDefined();
    expect(service?.runtime).toBe("${OPENGUI_SANDBOX_RUNTIME:-runsc}");
    expect(service?.privileged).not.toBe(true);
    expect(service?.network_mode).not.toBe("host");
    expect(service?.pid).not.toBe("host");
    expect(service?.ports).toEqual(["127.0.0.1:${OPENGUI_SANDBOX_PORT:-4840}:3000"]);
    expect(service?.cap_drop).toEqual(["ALL"]);
    expect(service?.security_opt).toContain("no-new-privileges:true");
    expect(service?.pids_limit).toBe(512);
    expect(service?.mem_limit).toBe("${OPENGUI_SANDBOX_MEMORY:-3g}");
    expect(service?.cpus).toBe("${OPENGUI_SANDBOX_CPUS:-2.0}");

    expect(service?.environment).toMatchObject({
      HOME: "/home/opengui",
      OPENGUI_ALLOWED_ROOTS: "/workspace",
      OPENGUI_DATA_DIR: "/app/.opengui-data",
      OPENGUI_PATH_GRANTS: "disabled",
      OPENGUI_SERVER_MODE: "combined",
    });

    const serializedMounts = JSON.stringify(service?.volumes ?? []);
    expect(serializedMounts).toContain("/workspace");
    expect(serializedMounts).toContain("/app/.opengui-data");
    expect(serializedMounts).not.toContain("docker.sock");
    expect(serializedMounts).not.toContain('"source":"/"');
    expect(serializedMounts).not.toContain("/root");
  });

  test("provides a repository-scoped SSH deployment credential without environment secrets", async () => {
    const compose = await sandboxCompose();
    const service = compose.services?.opengui;

    expect(service?.environment?.GIT_SSH_COMMAND).toContain("/run/secrets/github_deploy_key");
    expect(service?.environment?.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
    expect(JSON.stringify(service?.environment)).not.toContain("PRIVATE KEY");
    expect(service?.secrets).toContainEqual({
      source: "github_deploy_key",
      target: "github_deploy_key",
      mode: "0400",
    });
    expect(service?.secrets).toContainEqual({
      source: "github_known_hosts",
      target: "github_known_hosts",
      mode: "0444",
    });
    expect(compose.secrets?.github_deploy_key?.file).toBe(
      "${OPENGUI_GITHUB_DEPLOY_KEY_FILE:?set OPENGUI_GITHUB_DEPLOY_KEY_FILE}",
    );
  });
});
