/**
 * Sandbox shell image lifecycle automation (#152): image/runtime/keeper
 * verification, label-scoped cleanup, web-vs-shell readiness, upgrade
 * planning, offline-restore verification, opt-in alert webhook.
 *
 * Contract (docs/sandbox-hosting.md): dry-run by default; `--apply` locks
 * its own O_NOFOLLOW fd via flock(1) for the whole mutation (no relay, no
 * flags, removed `__apply` refuses); cleanup removes only eligible images by
 * immutable ID; keepers are never adopted/deleted/started; diagnostics are
 * fixed summaries with no secrets or customer data.
 *
 * Run with: node --experimental-strip-types scripts/sandbox-shell-lifecycle.ts <command>
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export type DockerResult = { status: number | null; stdout: string; stderr: string };
export type DockerCommand = (arguments_: string[]) => DockerResult;

export type FaultCode =
  | "image_missing"
  | "runtime_unavailable"
  | "keeper_missing"
  | "keeper_mismatch"
  | "keeper_collision"
  | "keeper_running"
  | "keeper_unverifiable"
  | "config_mismatch"
  | "probe_not_configured"
  | "broker_unreachable"
  | "broker_unauthorized"
  | "broker_rejected"
  | "probe_failed"
  | "probe_policy_breach"
  | "restore_checksum_mismatch"
  | "restore_digest_mismatch"
  | "restore_unverifiable"
  | "notify_failed"
  | "notify_skipped"
  | "lock_contended"
  | "lock_unavailable"
  | "cleanup_failed"
  | "lifecycle_test";

const FAULT_SUMMARY: Record<FaultCode, string> = {
  image_missing: "The configured shell image is not available in the selected Docker daemon.",
  runtime_unavailable: "The runsc runtime is not available in the selected Docker daemon.",
  keeper_missing: "The keeper container does not exist; create it with retain.",
  keeper_mismatch: "The keeper container does not match the configured shell image.",
  keeper_collision: "A foreign container owns the keeper name; refusing to touch it.",
  keeper_running: "The keeper container is running; it must stay unstarted.",
  keeper_unverifiable: "The keeper container could not be inspected.",
  config_mismatch: "Keeper, broker, and shell image configuration do not match.",
  probe_not_configured:
    "No authenticated restricted-grant probe is configured; image inspection alone is not readiness.",
  broker_unreachable: "The shell broker could not be reached.",
  broker_unauthorized: "The shell broker rejected the probe credentials.",
  broker_rejected: "The shell broker rejected the probe request.",
  probe_failed: "The restricted-grant probe did not succeed.",
  probe_policy_breach: "The probe observed access beyond the fixture grants.",
  restore_checksum_mismatch: "The restore archive checksum does not match.",
  restore_digest_mismatch: "The loaded image digest does not match the expected digest.",
  restore_unverifiable: "Restoration cannot be verified from the provided expectations.",
  notify_failed: "The alert webhook delivery failed.",
  notify_skipped: "No alert webhook is configured; staying OFF.",
  lock_contended: "Another lifecycle transition holds the lock; retry later instead of waiting.",
  lock_unavailable: "The lifecycle lock could not be used on this host.",
  cleanup_failed: "Scoped cleanup could not remove an eligible image.",
  lifecycle_test: "Lifecycle alert path test.",
};

export function faultSummary(fault: FaultCode): string {
  return FAULT_SUMMARY[fault];
}

export function faultLine(fault: FaultCode): string {
  return `${fault}: ${FAULT_SUMMARY[fault]}`;
}

export const KEEPER_CONTAINER_DEFAULT = "opengui-shell-image-keepalive";
export const KEEPER_LABEL = "opengui.shell.keeper";
export const KEEPER_IMAGE_LABEL = "opengui.shell.image";
export const DISPOSABLE_LABEL = "opengui.shell.disposable";
export const REVISION_LABEL = "org.opencontainers.image.revision";
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** Upper bound for any single real Docker invocation. */
export const DOCKER_TIMEOUT_MS = 15_000;
/** Exit code reserved for lock conflict by the flock supervisor. */
export const LOCK_CONFLICT_CODE = 99;

export function supportedCleanupFilter(): string {
  return `label=${DISPOSABLE_LABEL}=true`;
}

// ---- Lock: this process opens its own fd and locks it; no relay, no flags. ----
//
// The mutating CLI path opens the lock file itself (O_NOFOLLOW, inside the
// validated private directory), acquires LOCK_EX|LOCK_NB on that open file
// description via the real flock(1) binary pointed at the inherited fd, holds
// its own fd open for the entire awaited mutation, then closes it. The lock
// belongs to the shared open file description, so no other process can
// borrow it and there is nothing external to spoof.

export function defaultLockPath(): string | undefined {
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) return join(runtimeDir, "opengui-shell-lifecycle.lock");
  try {
    if (statSync("/run").isDirectory()) return "/run/opengui-shell-lifecycle.lock";
  } catch {
    return undefined;
  }
  return undefined;
}

export function validateLockPath(path: string | undefined): { ok: boolean; fault?: FaultCode } {
  if (!path || !isAbsolute(path)) return { ok: false, fault: "lock_unavailable" };
  try {
    if (lstatSync(path).isSymbolicLink()) return { ok: false, fault: "lock_unavailable" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return { ok: false, fault: "lock_unavailable" };
    }
  }
  try {
    const parent = statSync(dirname(path));
    const euid = typeof process.geteuid === "function" ? process.geteuid() : -1;
    if (!parent.isDirectory() || parent.uid !== euid || (parent.mode & 0o777 & 0o022) !== 0) {
      return { ok: false, fault: "lock_unavailable" };
    }
  } catch {
    return { ok: false, fault: "lock_unavailable" };
  }
  return { ok: true };
}

export type FlockFdRunner = (fd: number) => { status: number | null; error?: unknown };

/** Child fd number our open lock fd is shared at for the flock subprocess. */
export const LOCK_CHILD_FD = 3;

export type LockHandle = { fd: number; path: string };

export function openLifecycleLock(lockPath: string | undefined): LockHandle {
  if (!lockPath || !validateLockPath(lockPath).ok) throw codedError("lock_unavailable");
  try {
    const fd = openSync(
      lockPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
    return { fd, path: lockPath };
  } catch {
    throw codedError("lock_unavailable");
  }
}

export function acquireOwnLock(
  handle: LockHandle,
  run: FlockFdRunner,
): "acquired" | "contended" | "unavailable" {
  const result = run(handle.fd);
  if (result.error) return "unavailable";
  if (result.status === 0) return "acquired";
  if (result.status === LOCK_CONFLICT_CODE) return "contended";
  return "unavailable";
}

export const realFlockFd: FlockFdRunner = (fd) => {
  const result = spawnSync("flock", ["-n", "-E", `${LOCK_CONFLICT_CODE}`, `${LOCK_CHILD_FD}`], {
    stdio: ["ignore", "ignore", "ignore", fd],
    timeout: 10_000,
  });
  return { status: result.status, error: result.error };
};

export function closeLifecycleLock(handle: LockHandle): void {
  try {
    closeSync(handle.fd);
  } catch {
    // Already closed; the kernel lock releases with the last close either way.
  }
}

// ---- Environment ----

export type LifecycleEnv = {
  shellImage?: string;
  knownGoodImage?: string;
  previousKnownGoodImage?: string;
  keeperContainer: string;
  brokerImage?: string;
  endpoint?: string;
  grantFixtureRoot?: string;
  webhookUrl?: string;
  lockPath: string | undefined;
};

export function readLifecycleEnv(environment: NodeJS.ProcessEnv = process.env): LifecycleEnv {
  const endpoint = (
    environment.OPENGUI_SHELL_SANDBOX_ENDPOINT ??
    environment.OPENGUI_SHELL_SANDBOX_SOCKET ??
    ""
  ).trim();
  const webhookUrl = (environment.OPENGUI_SHELL_LIFECYCLE_WEBHOOK_URL ?? "").trim();
  return {
    shellImage: environment.OPENGUI_SHELL_IMAGE?.trim() || undefined,
    knownGoodImage: environment.OPENGUI_SHELL_KNOWN_GOOD_IMAGE?.trim() || undefined,
    previousKnownGoodImage:
      environment.OPENGUI_SHELL_PREVIOUS_KNOWN_GOOD_IMAGE?.trim() || undefined,
    keeperContainer: environment.OPENGUI_SHELL_KEEPER_CONTAINER?.trim() || KEEPER_CONTAINER_DEFAULT,
    brokerImage: environment.OPENGUI_SHELL_BROKER_IMAGE?.trim() || undefined,
    endpoint: endpoint || undefined,
    grantFixtureRoot: environment.OPENGUI_SHELL_PROBE_FIXTURE_ROOT?.trim() || undefined,
    webhookUrl: webhookUrl || undefined,
    lockPath: environment.OPENGUI_SHELL_LIFECYCLE_LOCK?.trim() || defaultLockPath(),
  };
}

export function resolveShellImageReference(input: { shellImage?: string; appImage?: string }): {
  reference: string | undefined;
  pinnedFromAppImage: boolean;
} {
  if (input.shellImage?.trim())
    return { reference: input.shellImage.trim(), pinnedFromAppImage: false };
  if (input.appImage?.trim()) return { reference: input.appImage.trim(), pinnedFromAppImage: true };
  return { reference: undefined, pinnedFromAppImage: false };
}

/** Fixed public-safe summary of a Docker failure; raw stderr never leaves this function. */
export function dockerErrorSummary(stderr: string): string {
  if (/no such image/iu.test(stderr)) return "image not found in the selected daemon";
  if (/no such container/iu.test(stderr)) return "container does not exist";
  if (
    /cannot connect|connection refused|daemon.*not running|ETIMEDOUT|timed out|deadline/iu.test(
      stderr,
    )
  ) {
    return "cannot reach the Docker daemon";
  }
  if (/permission denied/iu.test(stderr)) return "docker permission denied for the current user";
  return "docker command failed";
}

// ---- Image / runtime / keeper verification ----

export type ImageVerification = {
  reference: string;
  available: boolean;
  imageId?: string;
  digest?: string;
  revisionLabel?: string;
  fault?: FaultCode;
};

export function verifyShellImage(
  reference: string | undefined,
  docker: DockerCommand,
): ImageVerification {
  const trimmed = reference?.trim();
  if (!trimmed) return { reference: "", available: false, fault: "image_missing" };
  const idResult = docker(["image", "inspect", "--format", "{{.Id}}", "--", trimmed]);
  const imageId = idResult.stdout.trim();
  if (idResult.status !== 0 || !IMAGE_ID_PATTERN.test(imageId)) {
    return { reference: trimmed, available: false, fault: "image_missing" };
  }
  let digest: string | undefined;
  try {
    const digestsResult = docker([
      "image",
      "inspect",
      "--format",
      "{{json .RepoDigests}}",
      "--",
      trimmed,
    ]);
    if (digestsResult.status === 0) {
      const parsed = JSON.parse(digestsResult.stdout.trim()) as unknown;
      if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0]) digest = parsed[0];
    }
  } catch {
    digest = undefined;
  }
  let revisionLabel: string | undefined;
  try {
    const labelsResult = docker([
      "image",
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      "--",
      trimmed,
    ]);
    if (labelsResult.status === 0) {
      const parsed = JSON.parse(labelsResult.stdout.trim()) as unknown;
      if (parsed && typeof parsed === "object") {
        const value = (parsed as Record<string, unknown>)[REVISION_LABEL];
        if (typeof value === "string" && value.trim()) revisionLabel = value.trim();
      }
    }
  } catch {
    revisionLabel = undefined;
  }
  return { reference: trimmed, available: true, imageId, digest, revisionLabel };
}

export function checkImageProvenance(verification: ImageVerification): string[] {
  if (!verification.available) {
    return ["Image provenance cannot be assessed: the configured shell image is not available."];
  }
  const notes: string[] = [];
  if (!verification.digest) {
    notes.push(
      "No registry digest is recorded for the shell image. Pin deployments by immutable " +
        "digest (image@sha256:…) in addition to the tag, and re-verify after every pull or restore.",
    );
  }
  if (!verification.revisionLabel) {
    notes.push(
      `No source revision label (${REVISION_LABEL}) is recorded for the shell image. ` +
        "Label shell images with the exact source revision at build time so a deployed " +
        "image can be traced back to its commit.",
    );
  }
  return notes;
}

export type RuntimeVerification = {
  available: boolean;
  runtimes: string[];
  fault?: FaultCode;
};

export function verifyRuntime(docker: DockerCommand): RuntimeVerification {
  const result = docker([
    "info",
    "--format",
    "{{range $name, $_ := .Runtimes}}{{println $name}}{{end}}",
  ]);
  if (result.status !== 0) return { available: false, runtimes: [], fault: "runtime_unavailable" };
  const runtimes = result.stdout.split(/\s+/u).filter(Boolean);
  if (!runtimes.includes("runsc")) {
    return { available: false, runtimes, fault: "runtime_unavailable" };
  }
  return { available: true, runtimes };
}

export type KeeperRecord = {
  name: string;
  imageRef: string;
  imageId?: string;
  running: boolean;
  labels: Record<string, string>;
};

export type KeeperProbe =
  | { state: "absent" }
  | { state: "owned"; record: KeeperRecord }
  | { state: "collision"; record?: KeeperRecord }
  | { state: "error" };

export function parseKeeperProbe(name: string, docker: DockerCommand): KeeperProbe {
  const result = docker(["container", "inspect", "--", name]);
  if (result.status !== 0) {
    if (/no such container/iu.test(result.stderr)) return { state: "absent" };
    return { state: "error" };
  }
  try {
    const parsed = JSON.parse(result.stdout) as Array<{
      Name?: string;
      Image?: string;
      State?: { Running?: boolean };
      Config?: { Image?: string; Labels?: Record<string, string> | null };
    }>;
    const entry = parsed[0];
    if (!entry) return { state: "error" };
    const labels = entry.Config?.Labels ?? {};
    const record: KeeperRecord = {
      name: entry.Name ?? name,
      imageRef: entry.Config?.Image ?? "",
      imageId: entry.Image,
      running: entry.State?.Running === true,
      labels,
    };
    if (labels[KEEPER_LABEL] === "true") return { state: "owned", record };
    return { state: "collision", record };
  } catch {
    return { state: "error" };
  }
}

/** Our own image pin on a keeper record; foreign image refs are never resolved. */
export function keeperLabelToResolve(probe: KeeperProbe): string | undefined {
  const record = probe.state === "owned" || probe.state === "collision" ? probe.record : undefined;
  const pinned = record?.labels[KEEPER_IMAGE_LABEL]?.trim();
  return pinned || undefined;
}

export type KeeperVerification = { ok: boolean; fault?: FaultCode; sameImage?: boolean };

export function verifyKeeper(
  expectedImageId: string | undefined,
  probe: KeeperProbe,
  resolvedLabelIds: string[],
): KeeperVerification {
  if (!expectedImageId || !IMAGE_ID_PATTERN.test(expectedImageId)) {
    return { ok: false, fault: "config_mismatch" };
  }
  if (probe.state === "absent") return { ok: false, fault: "keeper_missing" };
  if (probe.state === "error") return { ok: false, fault: "keeper_unverifiable" };
  if (probe.state === "collision") {
    const recordId = probe.record?.imageId;
    const sameImage = recordId === expectedImageId || resolvedLabelIds.includes(expectedImageId);
    return { ok: false, fault: "keeper_collision", sameImage };
  }
  if (probe.record.running) return { ok: false, fault: "keeper_running" };
  const knownIds = new Set(resolvedLabelIds);
  if (probe.record.imageId && IMAGE_ID_PATTERN.test(probe.record.imageId)) {
    knownIds.add(probe.record.imageId);
  }
  if (knownIds.has(expectedImageId)) return { ok: true };
  return { ok: false, fault: "keeper_mismatch" };
}

export type KeeperApplyDecision =
  | { action: "create" | "noop" }
  | { action: "refuse"; fault: FaultCode; guidance: string };

export function keeperApplyDecision(keeper: KeeperVerification): KeeperApplyDecision {
  if (keeper.ok) return { action: "noop" };
  if (!keeper.fault || keeper.fault === "keeper_missing") return { action: "create" };
  if (keeper.fault === "keeper_collision" && keeper.sameImage) {
    return {
      action: "refuse",
      fault: keeper.fault,
      guidance:
        "an unlabeled container already pins this image. Migrate explicitly: create a labeled " +
        "keeper with retain --keeper <new-name>, verify with check, then remove the old container " +
        "yourself with docker rm. This tool never deletes containers.",
    };
  }
  if (keeper.fault === "keeper_collision") {
    return {
      action: "refuse",
      fault: keeper.fault,
      guidance:
        "refusing to delete or reuse a foreign container. " +
        "Use retain --keeper <new-name> for an explicit new-name transition.",
    };
  }
  if (keeper.fault === "keeper_mismatch") {
    return {
      action: "refuse",
      fault: keeper.fault,
      guidance:
        "keepers are never updated in place. Transition explicitly: retain --keeper <new-name>, " +
        "check, probe, then docker rm the old keeper yourself.",
    };
  }
  return { action: "refuse", fault: keeper.fault, guidance: "" };
}

export function verifyKeeperWithLabel(
  expectedImageId: string | undefined,
  probe: KeeperProbe,
  docker: DockerCommand,
): KeeperVerification {
  const labelRef = keeperLabelToResolve(probe);
  let resolvedLabels: string[] = [];
  if (labelRef) {
    const resolved = resolveProtectedIds([labelRef], docker);
    if (resolved.unresolved.length > 0) return { ok: false, fault: "keeper_unverifiable" };
    resolvedLabels = resolved.ids;
  }
  return verifyKeeper(expectedImageId, probe, resolvedLabels);
}

export function verifyConfigConsistency(input: {
  shellImage?: string;
  keeperImage?: string;
  brokerImage?: string;
}): { ok: boolean; fault?: FaultCode } {
  const shell = input.shellImage?.trim() || undefined;
  const keeper = input.keeperImage?.trim() || undefined;
  const broker = input.brokerImage?.trim() || undefined;
  if (!shell) return { ok: false, fault: "config_mismatch" };
  if ([keeper, broker].filter((value) => value !== undefined).some((value) => value !== shell)) {
    return { ok: false, fault: "config_mismatch" };
  }
  return { ok: true };
}

// ---- Readiness and restricted-grant probe ----

export type ProbeSummary = { ok: boolean; fault?: FaultCode };

export type ReadinessReport = {
  web: { ok: boolean };
  shell: { ok: boolean; fault?: FaultCode };
};

export function assessShellReadiness(input: {
  webOk: boolean;
  imageAvailable: boolean;
  runtimeAvailable: boolean;
  probeConfigured: boolean;
  probe?: ProbeSummary;
}): ReadinessReport {
  const web = { ok: input.webOk };
  if (!input.imageAvailable) return { web, shell: { ok: false, fault: "image_missing" } };
  if (!input.runtimeAvailable) return { web, shell: { ok: false, fault: "runtime_unavailable" } };
  if (!input.probeConfigured || !input.probe) {
    return { web, shell: { ok: false, fault: "probe_not_configured" } };
  }
  if (!input.probe.ok) {
    return { web, shell: { ok: false, fault: input.probe.fault ?? "probe_failed" } };
  }
  return { web, shell: { ok: true } };
}

export type ProbeGrant = { root: string; access: "read" | "write" };
export type ProbeExecResult =
  | { exitCode: number | null; output: string }
  | { denied: true; error: string };
export type ProbeExecutor = (input: {
  projectDirectory: string;
  grants: ProbeGrant[];
  command: string;
}) => Promise<ProbeExecResult>;
export type ProbeFixture = {
  projectRoot: string;
  readOnlyRoot: string;
  outsideRoot: string;
  identityPath: string;
};
export type ProbeReport = {
  ok: boolean;
  fault?: FaultCode;
  checks: {
    writeGrant: boolean;
    readOnlyEnforced: boolean;
    outOfGrantDenied: boolean;
    identityDataDenied: boolean;
  };
};

function probeFailedChecks(): ProbeReport["checks"] {
  return {
    writeGrant: false,
    readOnlyEnforced: false,
    outOfGrantDenied: false,
    identityDataDenied: false,
  };
}

function errorFault(error: unknown): FaultCode {
  const code = (error as { code?: unknown } | null)?.code;
  const known: FaultCode[] = [
    "broker_unreachable",
    "broker_unauthorized",
    "broker_rejected",
    "probe_not_configured",
  ];
  if (typeof code === "string" && (known as string[]).includes(code)) return code as FaultCode;
  return "probe_failed";
}

function isDenied(result: ProbeExecResult): boolean {
  return "denied" in result && result.denied === true;
}

export async function runRestrictedProbe(
  executor: ProbeExecutor | undefined,
  fixture: ProbeFixture | undefined,
): Promise<ProbeReport> {
  if (!executor || !fixture) {
    return { ok: false, fault: "probe_not_configured", checks: probeFailedChecks() };
  }
  const grants: ProbeGrant[] = [
    { root: fixture.projectRoot, access: "write" },
    { root: fixture.readOnlyRoot, access: "read" },
  ];
  try {
    const write = await executor({
      projectDirectory: fixture.projectRoot,
      grants,
      command: "echo probe-ok",
    });
    if (isDenied(write) || (write as { exitCode: number | null }).exitCode !== 0) {
      return { ok: false, fault: "probe_failed", checks: probeFailedChecks() };
    }
    const readOnly = await executor({
      projectDirectory: fixture.readOnlyRoot,
      grants,
      command: `touch ${fixture.readOnlyRoot}/probe-write-test`,
    });
    if (!isDenied(readOnly) && (readOnly as { exitCode: number | null }).exitCode === 0) {
      return {
        ok: false,
        fault: "probe_policy_breach",
        checks: { ...probeFailedChecks(), writeGrant: true },
      };
    }
    const outside = await executor({
      projectDirectory: fixture.outsideRoot,
      grants: [{ root: fixture.projectRoot, access: "write" }],
      command: "echo probe-ok",
    });
    if (!isDenied(outside)) {
      return {
        ok: false,
        fault: "probe_policy_breach",
        checks: { ...probeFailedChecks(), writeGrant: true, readOnlyEnforced: true },
      };
    }
    const identity = await executor({
      projectDirectory: fixture.projectRoot,
      grants: [{ root: fixture.projectRoot, access: "write" }],
      command: `cat ${fixture.identityPath}`,
    });
    if (!isDenied(identity)) {
      return {
        ok: false,
        fault: "probe_policy_breach",
        checks: {
          ...probeFailedChecks(),
          writeGrant: true,
          readOnlyEnforced: true,
          outOfGrantDenied: true,
        },
      };
    }
    return {
      ok: true,
      checks: {
        writeGrant: true,
        readOnlyEnforced: true,
        outOfGrantDenied: true,
        identityDataDenied: true,
      },
    };
  } catch (error) {
    return { ok: false, fault: errorFault(error), checks: probeFailedChecks() };
  }
}

export type BrokerHttpPost = (
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: { timeoutMs: number },
) => Promise<{ status: number; body: string }>;

function codedError(fault: FaultCode): Error {
  const error = new Error(FAULT_SUMMARY[fault]) as Error & { code: FaultCode };
  error.code = fault;
  return error;
}

export function assertBrokerTarget(endpoint: string): { socket: boolean; target: string } {
  const trimmed = endpoint.trim().replace(/\/+$/u, "");
  if (!trimmed) throw codedError("probe_not_configured");
  if (trimmed.startsWith("/")) return { socket: true, target: trimmed };
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw codedError("probe_not_configured");
    }
    return { socket: false, target: `${trimmed}/v1/execute` };
  } catch (error) {
    if ((error as { code?: unknown })?.code) throw error;
    throw codedError("probe_not_configured");
  }
}

export function createBrokerProbeExecutor(
  endpoint: string,
  token: string | undefined,
  httpPost: BrokerHttpPost,
  opts: { timeoutMs?: number } = {},
): ProbeExecutor {
  const { target } = assertBrokerTarget(endpoint);
  const timeoutMs = Math.min(30_000, Math.max(1_000, opts.timeoutMs ?? 8_000));
  return async (input) => {
    const body = JSON.stringify({
      projectDirectory: input.projectDirectory,
      grants: input.grants,
      input: { command: input.command },
      sessionId: "lifecycle-probe",
      toolCallId: "lifecycle-probe",
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
    let response: { status: number; body: string };
    try {
      response = await httpPost(target, body, headers, { timeoutMs });
    } catch (error) {
      if ((error as { code?: unknown })?.code === "response_too_large") {
        throw codedError("broker_rejected");
      }
      throw codedError("broker_unreachable");
    }
    if (response.status === 401) throw codedError("broker_unauthorized");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(response.body) as unknown;
    } catch {
      parsed = null;
    }
    const denied =
      parsed && typeof parsed === "object" && (parsed as { denied?: unknown }).denied === true;
    if (denied) return { denied: true, error: "broker denied execution" };
    if (response.status >= 400) throw codedError("broker_rejected");
    if (parsed && typeof parsed === "object" && "exitCode" in parsed) {
      const record = parsed as { exitCode: number | null; output?: unknown };
      return {
        exitCode: record.exitCode,
        output: typeof record.output === "string" ? record.output : "",
      };
    }
    throw codedError("broker_rejected");
  };
}

// ---- Bounded HTTP with abort/close guards ----

export function collectBoundedBody(
  response: IncomingMessage,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const fail = (error: Error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    };
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = new Error("response exceeds size bound") as Error & { code: string };
        error.code = "response_too_large";
        response.destroy(error);
        fail(error);
      } else {
        chunks.push(chunk);
      }
    });
    response.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    response.on("error", (error: Error) => fail(error));
    response.on("aborted", () => fail(new Error("response aborted")));
    response.on("close", () => {
      if (!done) fail(new Error("response closed before end"));
    });
  });
}

/** Strips the brackets Node's URL parser keeps on IPv6 literals. */
export function requestHostname(url: URL): string {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function guardedPost(
  kind: "socket" | "web",
  target: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let done = false;
    let responded = false;
    let request: ClientRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        request?.destroy();
      } catch {
        // The socket is already gone; the rejection below carries the signal.
      }
      reject(error);
    };
    const finish = (value: { status: number; body: string }) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    let url: URL | null = null;
    if (kind === "web") {
      try {
        url = new URL(target);
      } catch {
        fail(new Error("invalid endpoint URL"));
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        fail(new Error("invalid endpoint URL"));
        return;
      }
    }
    const sender = url && url.protocol === "https:" ? httpsRequest : httpRequest;
    try {
      request = sender(
        kind === "socket"
          ? {
              socketPath: target,
              path: "/v1/execute",
              method: "POST",
              headers: { ...headers, "content-length": Buffer.byteLength(body) },
            }
          : {
              hostname: url ? requestHostname(url) : undefined,
              port: url?.port,
              path: `${url?.pathname}${url?.search}`,
              method: "POST",
              headers: { ...headers, "content-length": Buffer.byteLength(body) },
            },
        (response) => {
          responded = true;
          collectBoundedBody(response).then(
            (responseBody) => {
              finish({ status: response.statusCode ?? 500, body: responseBody });
            },
            (error: Error) => {
              fail(error);
            },
          );
        },
      );
    } catch {
      fail(new Error("request could not be started"));
      return;
    }
    timer = setTimeout(() => {
      fail(new Error("request timed out"));
    }, timeoutMs);
    request.on("error", (error: Error) => {
      fail(error);
    });
    request.on("close", () => {
      // Request 'close' may fire before the response body completes, so it is
      // only a failure signal when no response was received at all — and the
      // total deadline keeps running until the body settles either way.
      if (!done && !responded) fail(new Error("request closed before response"));
    });
    request.end(body);
  });
}

export function liveBrokerPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: { timeoutMs: number },
): Promise<{ status: number; body: string }> {
  if (url.startsWith("/")) return guardedPost("socket", url, body, headers, opts.timeoutMs);
  return guardedPost("web", url, body, headers, opts.timeoutMs);
}

// ---- Cleanup: immutable IDs only, fail closed ----

export function resolveImageId(
  reference: string | undefined,
  docker: DockerCommand,
): string | undefined {
  const trimmed = reference?.trim();
  if (!trimmed) return undefined;
  const result = docker(["image", "inspect", "--format", "{{.Id}}", "--", trimmed]);
  const id = result.stdout.trim();
  if (result.status !== 0 || !IMAGE_ID_PATTERN.test(id)) return undefined;
  return id;
}

export function resolveProtectedIds(
  references: Array<string | undefined>,
  docker: DockerCommand,
): { ids: string[]; unresolved: string[] } {
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const reference of new Set(references.map((value) => value?.trim()).filter(Boolean))) {
    const id = resolveImageId(reference, docker);
    if (id) ids.push(id);
    else unresolved.push(reference as string);
  }
  return { ids, unresolved };
}

export type CandidateImage = {
  id: string;
  repoTags: string[];
  labels: Record<string, string>;
};

export function collectCleanupCandidates(docker: DockerCommand): {
  listed: boolean;
  candidates: CandidateImage[];
  skipped: number;
} {
  const candidates: CandidateImage[] = [];
  let skipped = 0;
  const list = docker([
    "images",
    "--no-trunc",
    "--format",
    "{{json .}}",
    "--filter",
    supportedCleanupFilter(),
  ]);
  if (list.status !== 0) return { listed: false, candidates, skipped };
  for (const line of list.stdout
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)) {
    let id = "";
    try {
      id = (JSON.parse(line) as { ID?: string }).ID?.trim() ?? "";
    } catch {
      skipped += 1;
      continue;
    }
    if (!IMAGE_ID_PATTERN.test(id)) {
      skipped += 1;
      continue;
    }
    const inspected = docker(["image", "inspect", "--format", "{{json .}}", "--", id]);
    if (inspected.status !== 0) {
      skipped += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(inspected.stdout) as {
        Id?: string;
        RepoTags?: string[] | null;
        Config?: { Labels?: Record<string, string> | null } | null;
      };
      if (!parsed.Id || !IMAGE_ID_PATTERN.test(parsed.Id)) {
        skipped += 1;
        continue;
      }
      candidates.push({
        id: parsed.Id,
        repoTags: Array.isArray(parsed.RepoTags) ? parsed.RepoTags.filter(Boolean) : [],
        labels: parsed.Config?.Labels ?? {},
      });
    } catch {
      skipped += 1;
    }
  }
  return { listed: true, candidates, skipped };
}

export type CleanupPlan = {
  preserve: CandidateImage[];
  eligible: CandidateImage[];
  excludedForeign: CandidateImage[];
  removeArgv: string[][];
  warnings: string[];
};

export function planScopedCleanup(input: {
  protectedIds: string[];
  images: CandidateImage[];
}): CleanupPlan {
  const protectedSet = new Set(input.protectedIds);
  const preserve: CandidateImage[] = [];
  const eligible: CandidateImage[] = [];
  const excludedForeign: CandidateImage[] = [];
  for (const image of input.images) {
    if (!IMAGE_ID_PATTERN.test(image.id)) {
      excludedForeign.push(image);
    } else if (protectedSet.has(image.id)) {
      preserve.push(image);
    } else if (image.labels[DISPOSABLE_LABEL] === "true") {
      eligible.push(image);
    } else {
      excludedForeign.push(image);
    }
  }
  return {
    preserve,
    eligible,
    excludedForeign,
    removeArgv: eligible.map((image) => ["image", "rm", "--", image.id]),
    warnings: [
      "Only images labeled opengui.shell.disposable=true are eligible, and only via " +
        "explicit `docker image rm`. Global `image prune -a`, `container prune`, and " +
        "`system prune` are unsupported on shell hosts.",
      "A keeper container does not protect its image against container/system/forced " +
        "removal (`docker rm -f`, `system prune`, `image rm --force`); restore and " +
        "re-verify the image instead of relying on the keeper alone.",
    ],
  };
}

/** Re-inspect immediately before removal: labels and protection must still hold. */
export function verifyEligibleBeforeRemove(
  candidateId: string,
  protectedIds: string[],
  docker: DockerCommand,
): boolean {
  if (!IMAGE_ID_PATTERN.test(candidateId) || protectedIds.includes(candidateId)) return false;
  const inspected = docker(["image", "inspect", "--format", "{{json .}}", "--", candidateId]);
  if (inspected.status !== 0) return false;
  try {
    const parsed = JSON.parse(inspected.stdout) as {
      Id?: string;
      Config?: { Labels?: Record<string, string> | null } | null;
    };
    return parsed.Id === candidateId && parsed.Config?.Labels?.[DISPOSABLE_LABEL] === "true";
  } catch {
    return false;
  }
}

// ---- Upgrade plan (operator-driven only) and rollback guard ----

export type UpgradePlan = { steps: string[]; blockers: string[]; canMarkKnownGood: boolean };

export function planUpgrade(input: {
  currentKnownGood?: string;
  newImageAvailable: boolean;
  keeperMatchesNew: boolean;
  configMatchesNew: boolean;
  probeOk?: boolean;
}): UpgradePlan {
  const steps = [
    "Verify the new image referenced by OPENGUI_SHELL_IMAGE is available",
    "Create a new-name keeper for the new image (retain --keeper <new-name>); mismatched keepers are never updated in place",
    "Update the broker configuration to the new image consistently",
    "Restart the broker via explicit operator action (automation never restarts services)",
    "Run an authenticated restricted-grant probe against the restarted broker",
    `Mark the new image known-good only after verification; retain ${
      input.currentKnownGood ?? "the previous known-good image"
    } as rollback target, then remove the old keeper yourself with docker rm`,
  ];
  const blockers: string[] = [];
  if (!input.newImageAvailable)
    blockers.push("new image is not available; restore it before continuing");
  if (!input.keeperMatchesNew) blockers.push("keeper does not match the new image");
  if (!input.configMatchesNew) blockers.push("keeper/broker configuration is inconsistent");
  if (input.probeOk !== true)
    blockers.push("restricted-grant probe has not passed for the new image");
  return { steps, blockers, canMarkKnownGood: blockers.length === 0 };
}

export function checkRollbackTarget(input: { targetImage?: string; targetAvailable: boolean }): {
  ok: boolean;
  fault?: FaultCode;
} {
  if (!input.targetImage?.trim()) return { ok: false, fault: "image_missing" };
  if (!input.targetAvailable) return { ok: false, fault: "image_missing" };
  return { ok: true };
}

// ---- Offline restore: archive fact and loaded-image fact, kept separate ----

export function sha256FileStream(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (error: Error) => reject(error));
  });
}

export function verifyRestoration(input: {
  expectedArchiveSha256?: string;
  actualArchiveSha256?: string;
  imageLoaded: boolean;
  expectedImageDigest?: string;
  actualImageDigest?: string;
}): { ok: boolean; fault?: FaultCode } {
  if (!input.expectedArchiveSha256 || !input.expectedImageDigest) {
    return { ok: false, fault: "restore_unverifiable" };
  }
  if (input.actualArchiveSha256?.toLowerCase() !== input.expectedArchiveSha256.toLowerCase()) {
    return { ok: false, fault: "restore_checksum_mismatch" };
  }
  if (!input.imageLoaded) return { ok: false, fault: "image_missing" };
  if (input.actualImageDigest !== input.expectedImageDigest) {
    return { ok: false, fault: "restore_digest_mismatch" };
  }
  return { ok: true };
}

// ---- Alert webhook: fixed fault summaries only ----

export type AlertHttpPost = (
  url: string,
  body: string,
  opts: { timeoutMs: number },
) => Promise<{ status: number }>;

export type AlertResult = {
  delivered: boolean;
  skipped?: boolean;
  fault?: FaultCode;
  attempts: number;
};

function isLoopbackHttp(url: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//u.test(url);
}

export async function sendLifecycleAlert(
  input: { webhookUrl?: string; faultCode: FaultCode },
  httpPost: AlertHttpPost,
  opts: { timeoutMs?: number; maxAttempts?: number } = {},
): Promise<AlertResult> {
  if (!input.webhookUrl?.trim()) {
    return { delivered: false, skipped: true, fault: "notify_skipped", attempts: 0 };
  }
  const url = input.webhookUrl.trim();
  if (!url.startsWith("https://") && !isLoopbackHttp(url)) {
    return { delivered: false, fault: "notify_failed", attempts: 0 };
  }
  const timeoutMs = Math.min(15_000, Math.max(1_000, opts.timeoutMs ?? 5_000));
  const maxAttempts = Math.min(3, Math.max(1, opts.maxAttempts ?? 2));
  const body = JSON.stringify({ fault: input.faultCode, summary: FAULT_SUMMARY[input.faultCode] });
  let attempts = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    attempts += 1;
    try {
      const response = await httpPost(url, body, { timeoutMs });
      if (response.status >= 200 && response.status < 300) return { delivered: true, attempts };
    } catch {
      // Bounded retry; delivery failure is reported, never thrown.
    }
  }
  return { delivered: false, fault: "notify_failed", attempts };
}

// ---- Probe fixture: disposable layout, never a customer project ----
//
// Enforcement, not comments: init refuses any pre-existing root that is not
// provably our fixture (exact marker content, entries limited to the known
// set, no symlinks anywhere) BEFORE mutating anything, and never chmods
// existing paths. Modes are set only at creation time.

export const FIXTURE_MARKER_NAME = "identity-fixture.txt";
const FIXTURE_MARKER = "lifecycle probe fixture marker; not customer data\n";
const FIXTURE_CHILDREN = ["project", "readonly", "outside"] as const;

export type FixtureInitError = Error & {
  code: "fixture_not_absolute" | "fixture_not_owned" | "fixture_io";
};

function fixtureError(code: FixtureInitError["code"]): FixtureInitError {
  const messages = {
    fixture_not_absolute: "fixture root must be an absolute path",
    fixture_not_owned: "refusing to modify a directory that is not a lifecycle fixture",
    fixture_io: "cannot initialize the probe fixture directory",
  };
  const error = new Error(messages[code]) as FixtureInitError;
  error.code = code;
  return error;
}

function isRealDirectory(path: string): boolean {
  try {
    // lstat never follows symlinks, so symlinked entries fail this check.
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRealFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export type FixtureLayout = {
  root: string;
  project: string;
  readonly: string;
  outside: string;
  identityFile: string;
};

export function fixtureLayout(root: string): FixtureLayout {
  return {
    root,
    project: join(root, "project"),
    readonly: join(root, "readonly"),
    outside: join(root, "outside"),
    identityFile: join(root, FIXTURE_MARKER_NAME),
  };
}

export function verifyFixtureLayout(root: string | undefined): { ok: boolean; missing: string[] } {
  if (!root || !isAbsolute(root)) return { ok: false, missing: ["fixture root"] };
  const layout = fixtureLayout(root);
  const missing: string[] = [];
  for (const entry of [layout.project, layout.readonly, layout.outside]) {
    if (!isRealDirectory(entry)) missing.push(entry);
  }
  if (!isRealFile(layout.identityFile)) missing.push(layout.identityFile);
  return { ok: missing.length === 0, missing };
}

/** Throws unless root is provably our fixture; reads but never mutates. */
function assertOwnedFixture(root: string, layout: FixtureLayout): void {
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw fixtureError("fixture_io");
  }
  if (!rootStat.isDirectory()) throw fixtureError("fixture_not_owned");
  const allowed = new Set([...FIXTURE_CHILDREN, FIXTURE_MARKER_NAME]);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    throw fixtureError("fixture_io");
  }
  if (entries.some((entry) => !allowed.has(entry))) throw fixtureError("fixture_not_owned");
  let marker: string;
  try {
    marker = readFileSync(layout.identityFile, "utf8");
  } catch {
    throw fixtureError("fixture_not_owned");
  }
  if (!isRealFile(layout.identityFile) || marker !== FIXTURE_MARKER) {
    throw fixtureError("fixture_not_owned");
  }
  for (const child of [layout.project, layout.readonly, layout.outside]) {
    if (!isRealDirectory(child) && existsSync(child)) throw fixtureError("fixture_not_owned");
  }
}

export function initFixtureLayout(root: string): FixtureLayout {
  if (!root || !isAbsolute(root)) throw fixtureError("fixture_not_absolute");
  const layout = fixtureLayout(root);
  let created = false;
  try {
    lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw fixtureError("fixture_io");
    try {
      // Non-recursive: EEXIST surfaces a concurrent creation instead of adopting it.
      mkdirSync(root, { mode: 0o700 });
      created = true;
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw fixtureError("fixture_io");
      }
    }
  }
  // Ownership proof comes before ANY mutation of pre-existing paths: a
  // pre-existing root without our exact marker (or with foreign/symlinked
  // entries) is refused untouched.
  if (created) {
    for (const child of [layout.project, layout.readonly, layout.outside]) {
      mkdirSync(child, { mode: 0o700 });
    }
    writeFileSync(layout.identityFile, FIXTURE_MARKER, { mode: 0o600 });
  }
  assertOwnedFixture(root, layout);
  if (!created) {
    // Owned fixture: complete missing children, never touch existing paths.
    for (const child of [layout.project, layout.readonly, layout.outside]) {
      if (!existsSync(child)) mkdirSync(child, { mode: 0o700 });
    }
  }
  return layout;
}

function layoutToProbeFixture(layout: FixtureLayout): ProbeFixture {
  return {
    projectRoot: layout.project,
    readOnlyRoot: layout.readonly,
    outsideRoot: layout.outside,
    identityPath: layout.identityFile,
  };
}

// ---- CLI surface ----

export type LifecycleCommand =
  | "check"
  | "probe"
  | "retain"
  | "cleanup"
  | "upgrade-plan"
  | "restore-verify"
  | "notify-test";

export type ParsedArgs = {
  command: LifecycleCommand;
  apply: boolean;
  lockPath?: string;
  keeper?: string;
  initFixture: boolean;
  alertOnFailure: boolean;
};

const KNOWN_COMMANDS: LifecycleCommand[] = [
  "check",
  "probe",
  "retain",
  "cleanup",
  "upgrade-plan",
  "restore-verify",
  "notify-test",
];

export function parseLifecycleArgs(argv: string[]): ParsedArgs {
  const [command, ...flags] = argv;
  if (!command || !KNOWN_COMMANDS.includes(command as LifecycleCommand)) {
    throw new Error(
      `unknown command ${command ?? "(none)"}; expected one of ${KNOWN_COMMANDS.join(", ")}`,
    );
  }
  const takeValue = (flag: string): string | undefined => {
    const index = flags.indexOf(flag);
    if (index < 0) return undefined;
    const value = flags[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
  };
  const keeper = takeValue("--keeper");
  if (keeper !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(keeper)) {
    throw new Error("--keeper must be a plain container name");
  }
  const lockPath = takeValue("--lock");
  return {
    command: command as LifecycleCommand,
    apply: flags.includes("--apply"),
    lockPath,
    keeper,
    initFixture: flags.includes("--init-fixture"),
    alertOnFailure: flags.includes("--alert-on-failure"),
  };
}

const runDocker: DockerCommand = (arguments_) => {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DOCKER_TIMEOUT_MS,
  });
  if (result.error) {
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.error.message };
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export function liveAlertPost(
  url: string,
  body: string,
  opts: { timeoutMs: number },
): Promise<{ status: number }> {
  return guardedPost("web", url, body, { "content-type": "application/json" }, opts.timeoutMs).then(
    (response) => ({ status: response.status }),
  );
}

function exitWith(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

/** Runs a mutating command with this process's own lock held for the whole mutation. */
async function withOwnLock(
  lockPath: string | undefined,
  mutate: () => Promise<void>,
): Promise<void> {
  let handle: LockHandle;
  try {
    handle = openLifecycleLock(lockPath);
  } catch {
    exitWith(
      `${faultLine("lock_unavailable")}: set OPENGUI_SHELL_LIFECYCLE_LOCK to a lock file in a private owner-controlled directory`,
      2,
    );
  }
  const state = acquireOwnLock(handle, realFlockFd);
  if (state !== "acquired") {
    closeLifecycleLock(handle);
    exitWith(
      state === "contended" ? faultLine("lock_contended") : faultLine("lock_unavailable"),
      2,
    );
  }
  try {
    await mutate();
  } finally {
    closeLifecycleLock(handle);
  }
}

async function maybeAlert(
  enabled: boolean,
  webhookUrl: string | undefined,
  fault: FaultCode,
): Promise<void> {
  if (!enabled) return;
  if (!webhookUrl) {
    console.info("alert: not configured; staying OFF");
    return;
  }
  const result = await sendLifecycleAlert({ webhookUrl, faultCode: fault }, liveAlertPost);
  console.info(
    result.delivered ? `alert: delivered (${fault})` : "alert: delivery failed (notify_failed)",
  );
}

async function runCheck(alertOnFailure: boolean, webhookUrl: string | undefined): Promise<void> {
  const env = readLifecycleEnv();
  const image = verifyShellImage(env.shellImage, runDocker);
  const runtime = verifyRuntime(runDocker);
  const failures: FaultCode[] = [];
  if (!image.available) failures.push("image_missing");
  if (!runtime.available) failures.push("runtime_unavailable");
  if (image.available && image.imageId) {
    const keeper = verifyKeeperWithLabel(
      image.imageId,
      parseKeeperProbe(env.keeperContainer, runDocker),
      runDocker,
    );
    if (!keeper.ok && keeper.fault) failures.push(keeper.fault);
  }
  for (const note of checkImageProvenance(image)) console.info(`provenance: ${note}`);
  if (failures.length > 0) {
    console.error(
      `Lifecycle check failed:\n- ${failures.map((fault) => faultLine(fault)).join("\n- ")}`,
    );
    if (env.brokerImage && image.available) {
      const consistency = verifyConfigConsistency({
        shellImage: image.imageId,
        keeperImage: image.imageId,
        brokerImage: resolveImageId(env.brokerImage, runDocker),
      });
      if (!consistency.ok) console.error(`- ${faultLine("config_mismatch")}`);
    } else if (image.available) {
      console.info("note: OPENGUI_SHELL_BROKER_IMAGE is unset; broker consistency unchecked");
    }
    await maybeAlert(alertOnFailure, webhookUrl, failures[0] ?? "image_missing");
    process.exit(1);
  }
  console.info("Lifecycle check passed: image, runtime, and keeper are consistent.");
  console.info("Image inspection is not execution readiness; run the probe command next.");
}

function decideKeeper(keeperName: string, imageId: string): KeeperApplyDecision {
  const probe = parseKeeperProbe(keeperName, runDocker);
  const keeper = verifyKeeperWithLabel(imageId, probe, runDocker);
  return keeperApplyDecision(keeper);
}

async function createKeeper(keeperName: string, imageId: string): Promise<void> {
  const created = runDocker([
    "create",
    "--pull=never",
    "--name",
    keeperName,
    "--label",
    `${KEEPER_LABEL}=true`,
    "--label",
    `${KEEPER_IMAGE_LABEL}=${imageId}`,
    "--entrypoint",
    "/bin/true",
    imageId,
  ]);
  if (created.status !== 0) {
    exitWith(`${faultLine("keeper_unverifiable")}: ${dockerErrorSummary(created.stderr)}`, 1);
  }
  console.info("Keeper created unstarted. Re-run check to verify.");
}

type CleanupTargets = { plan: CleanupPlan; protectedIds: string[]; skipped: number };

async function resolveCleanupTargets(includeKeeper: boolean): Promise<CleanupTargets> {
  const env = readLifecycleEnv();
  let keeperImageId: string | undefined;
  if (includeKeeper) {
    const keeperProbe = parseKeeperProbe(env.keeperContainer, runDocker);
    keeperImageId =
      keeperProbe.state === "owned" || keeperProbe.state === "collision"
        ? keeperProbe.record?.imageId
        : undefined;
  }
  if (!env.shellImage?.trim()) {
    exitWith("cannot plan cleanup without OPENGUI_SHELL_IMAGE; refusing (fail closed)", 1);
  }
  const resolved = resolveProtectedIds(
    [env.shellImage, env.knownGoodImage, env.previousKnownGoodImage, keeperImageId],
    runDocker,
  );
  if (resolved.unresolved.length > 0) {
    exitWith(
      `${resolved.unresolved.length} protected image reference(s) could not be resolved; ` +
        "refusing cleanup (fail closed). Restore and re-verify the missing reference first.",
      1,
    );
  }
  const collected = collectCleanupCandidates(runDocker);
  if (!collected.listed) {
    exitWith("cannot list disposable images; refusing cleanup (fail closed)", 1);
  }
  const plan = planScopedCleanup({ protectedIds: resolved.ids, images: collected.candidates });
  console.info(
    `Cleanup plan: preserve ${plan.preserve.length}, eligible ${plan.eligible.length}, ` +
      `excluded foreign ${plan.excludedForeign.length}, skipped unverifiable ${collected.skipped}.`,
  );
  for (const warning of plan.warnings) console.info(`note: ${warning}`);
  return { plan, protectedIds: resolved.ids, skipped: collected.skipped };
}

async function runCleanupApply(): Promise<void> {
  const { plan, protectedIds } = await resolveCleanupTargets(true);
  for (const argv of plan.removeArgv) {
    const id = argv.at(-1) ?? "";
    if (!verifyEligibleBeforeRemove(id, protectedIds, runDocker)) {
      exitWith(
        `candidate ${id} no longer verifies as eligible; aborting cleanup before any removal`,
        1,
      );
    }
    const removed = runDocker(argv);
    if (removed.status !== 0) {
      exitWith(`${faultLine("cleanup_failed")}: ${dockerErrorSummary(removed.stderr)}`, 1);
    }
  }
  console.info("Scoped cleanup applied. Re-run check and probe afterwards.");
}

async function previewCleanup(): Promise<void> {
  const { plan } = await resolveCleanupTargets(false);
  for (const argv of plan.removeArgv) console.info(`would run: docker ${argv.join(" ")}`);
}

type KeeperTarget = { keeperName: string; imageId: string; decision: KeeperApplyDecision };

function resolveKeeperTarget(keeperName: string): KeeperTarget {
  const image = verifyShellImage(readLifecycleEnv().shellImage, runDocker);
  if (!image.available || !image.imageId) exitWith(faultLine("image_missing"), 1);
  return { keeperName, imageId: image.imageId, decision: decideKeeper(keeperName, image.imageId) };
}

function refuseWith(decision: Extract<KeeperApplyDecision, { action: "refuse" }>): never {
  exitWith(
    decision.guidance
      ? `${faultLine(decision.fault)}: ${decision.guidance}`
      : faultLine(decision.fault),
    1,
  );
}

async function runRetainMutation(keeperName: string): Promise<void> {
  const { decision, imageId } = resolveKeeperTarget(keeperName);
  if (decision.action === "noop") {
    console.info("Keeper already matches the configured image; nothing to do.");
    return;
  }
  if (decision.action === "refuse") refuseWith(decision);
  const env = readLifecycleEnv();
  if (!env.shellImage) exitWith(faultLine("image_missing"), 1);
  await createKeeper(keeperName, imageId);
}

async function main(): Promise<void> {
  const originalArgv = process.argv.slice(2);
  if (originalArgv[0] === "__apply") {
    exitWith(
      "refused: the internal apply route is removed and never executes; run with --apply, " +
        "which supervises the transition with a kernel lock held by this process",
      2,
    );
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseLifecycleArgs(originalArgv);
  } catch (error) {
    exitWith(error instanceof Error ? error.message : String(error), 2);
  }
  const env = readLifecycleEnv();

  const needsLock = parsed.apply && (parsed.command === "retain" || parsed.command === "cleanup");
  if (needsLock) {
    const lockPath = parsed.lockPath ?? env.lockPath;
    if (parsed.command === "retain") {
      await withOwnLock(lockPath, () => runRetainMutation(parsed.keeper ?? env.keeperContainer));
    } else {
      await withOwnLock(lockPath, runCleanupApply);
    }
    return;
  }

  switch (parsed.command) {
    case "upgrade-plan": {
      const plan = planUpgrade({
        currentKnownGood: env.knownGoodImage,
        newImageAvailable: false,
        keeperMatchesNew: false,
        configMatchesNew: false,
        probeOk: undefined,
      });
      console.info("Upgrade steps (operator-driven; automation never restarts services):");
      for (const step of plan.steps) console.info(`- ${step}`);
      console.info("Upgrade application is intentionally not automated; verify each step.");
      return;
    }
    case "restore-verify": {
      const archive = process.env.OPENGUI_SHELL_RESTORE_ARCHIVE?.trim();
      const expectedArchiveSha256 = process.env.OPENGUI_SHELL_RESTORE_ARCHIVE_SHA256?.trim();
      const restoreImage = process.env.OPENGUI_SHELL_RESTORE_IMAGE?.trim();
      const expectedImageDigest = process.env.OPENGUI_SHELL_RESTORE_IMAGE_DIGEST?.trim();
      if (!archive || !expectedArchiveSha256 || !restoreImage || !expectedImageDigest) {
        exitWith(
          "restore-verify requires OPENGUI_SHELL_RESTORE_ARCHIVE, " +
            "OPENGUI_SHELL_RESTORE_ARCHIVE_SHA256, OPENGUI_SHELL_RESTORE_IMAGE, and " +
            "OPENGUI_SHELL_RESTORE_IMAGE_DIGEST",
          2,
        );
      }
      let actualArchiveSha256: string;
      try {
        actualArchiveSha256 = await sha256FileStream(archive as string);
      } catch {
        exitWith("cannot read the restore archive file", 1);
      }
      const loaded = verifyShellImage(restoreImage, runDocker);
      const result = verifyRestoration({
        expectedArchiveSha256,
        actualArchiveSha256,
        imageLoaded: loaded.available,
        expectedImageDigest,
        actualImageDigest: loaded.digest,
      });
      if (!result.ok) {
        if (result.fault === "image_missing") {
          exitWith(
            "expected image is not loaded; run the explicit operator docker load step, then re-run restore-verify",
            1,
          );
        }
        exitWith(faultLine(result.fault ?? "restore_unverifiable"), 1);
      }
      console.info("archive checksum matches the expected archive checksum.");
      console.info("loaded image digest matches the expected image digest.");
      console.info(
        "These are two separate facts. The operator load between them is not attested by this tool.",
      );
      return;
    }
    case "notify-test": {
      const result = await sendLifecycleAlert(
        { webhookUrl: env.webhookUrl, faultCode: "lifecycle_test" },
        liveAlertPost,
      );
      if (result.skipped) {
        console.info("Alert webhook is not configured; staying OFF (no network use).");
        return;
      }
      if (!result.delivered) exitWith(faultLine("notify_failed"), 1);
      console.info("Alert delivery test passed.");
      return;
    }
    case "check": {
      await runCheck(parsed.alertOnFailure, env.webhookUrl);
      return;
    }
    case "retain": {
      const { keeperName, imageId, decision } = resolveKeeperTarget(
        parsed.keeper ?? env.keeperContainer,
      );
      if (decision.action === "noop") {
        console.info("Keeper already matches the configured image; nothing to do.");
        return;
      }
      if (decision.action === "refuse") {
        console.info(`--apply would refuse: ${faultLine(decision.fault)}`);
        if (decision.guidance) console.info(`guidance: ${decision.guidance}`);
        return;
      }
      console.info(
        "Dry run. To create the unstarted keeper under the lifecycle lock, run with --apply.",
      );
      console.info(
        `docker create --name ${keeperName} --label ${KEEPER_LABEL}=true --label ` +
          `${KEEPER_IMAGE_LABEL}=${imageId} --entrypoint /bin/true ${imageId}`,
      );
      console.info(
        "The keeper is never started; it only pins the image against label-scoped cleanup.",
      );
      return;
    }
    case "cleanup": {
      await previewCleanup();
      return;
    }
    case "probe": {
      if (!env.endpoint) exitWith(faultLine("probe_not_configured"), 1);
      try {
        assertBrokerTarget(env.endpoint);
      } catch {
        exitWith(faultLine("probe_not_configured"), 1);
      }
      if (!env.grantFixtureRoot) exitWith(faultLine("probe_not_configured"), 1);
      if (parsed.initFixture) {
        try {
          initFixtureLayout(env.grantFixtureRoot);
          console.info("Probe fixture initialized as a disposable layout.");
        } catch {
          exitWith("cannot initialize the probe fixture directory", 2);
        }
      }
      const fixture = verifyFixtureLayout(env.grantFixtureRoot);
      if (!fixture.ok) {
        exitWith(
          `${faultLine("probe_not_configured")}: probe requires an initialized disposable fixture; run probe --init-fixture first`,
          1,
        );
      }
      const layout = fixtureLayout(env.grantFixtureRoot);
      const executor = createBrokerProbeExecutor(
        env.endpoint,
        process.env.OPENGUI_SHELL_BROKER_TOKEN?.trim() ||
          process.env.OPENGUI_SHELL_SANDBOX_TOKEN?.trim(),
        liveBrokerPost,
      );
      const report = await runRestrictedProbe(executor, layoutToProbeFixture(layout));
      if (!report.ok) {
        console.error(faultLine(report.fault ?? "probe_failed"));
        console.error(
          "Direct broker probe only; it does not verify the Host/Account-to-Harness path.",
        );
        await maybeAlert(parsed.alertOnFailure, env.webhookUrl, report.fault ?? "probe_failed");
        process.exit(1);
      }
      console.info("Restricted-grant probe passed: write, read-only, and denial checks hold.");
      console.info(
        "Direct broker probe only; it does not verify the Host/Account-to-Harness path.",
      );
      return;
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {
    console.error("lifecycle command failed");
    process.exit(1);
  });
}
