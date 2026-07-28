import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadSkillsFromDir, type DurableActor } from "@opengui/harness";
import { DurableJsonCommitError, openDurableJsonTransaction } from "./durable-json-transaction.ts";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_BYTES = 4 * 1024 * 1024;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

export type SkillScope = "project" | "host";
export type SkillSourceKind = "github";

export type SkillSourceDescriptor = {
  kind: SkillSourceKind;
  grammar: "github:OWNER/REPOSITORY/PATH@REF";
  example: string;
  mutableRefsResolved: true;
  legacyGrammar: "OWNER/REPOSITORY@SKILL";
};

export type SkillSourceFile = {
  path: string;
  contents: Uint8Array;
  type?: "file" | "symlink" | "directory" | "special";
  links?: number;
};

export type ResolvedSkillSource = {
  requested: string;
  canonical: string;
  revision: string;
  path: string;
  files: SkillSourceFile[];
};

export type SkillSourceResolver = (source: string) => Promise<ResolvedSkillSource>;

type LockEntry = {
  name: string;
  source: string;
  resolvedSource: string;
  revision: string;
  sourcePath: string;
  contentHash: string;
  installedAt: string;
  updatedAt: string;
};

type SkillLock = {
  version: 2;
  generation: number;
  skills: Record<string, LockEntry>;
  requests: Record<
    string,
    { operation: "install" | "update" | "remove"; name: string; generation: number }
  >;
};

export type SkillInstallation = {
  name: string;
  description: string;
  manual: boolean;
  scope: SkillScope;
  location: string;
  managed: boolean;
  modified: boolean;
  generation: number;
  source?: string;
  resolvedSource?: string;
  revision?: string;
};

export class SkillManagementError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function supportedSkillSources(): SkillSourceDescriptor[] {
  return [
    {
      kind: "github",
      grammar: "github:OWNER/REPOSITORY/PATH@REF",
      example: "github:acme/agent-skills/review@0123456789abcdef0123456789abcdef01234567",
      mutableRefsResolved: true,
      legacyGrammar: "OWNER/REPOSITORY@SKILL",
    },
  ];
}

type ParsedSource = { owner: string; repo: string; path: string; ref: string; legacy: boolean };

export function parseSkillSource(source: string): ParsedSource {
  const value = source.trim();
  const explicit =
    /^github:([A-Za-z0-9](?:[A-Za-z0-9.-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/(.+)@([^@]+)$/u.exec(
      value,
    );
  if (explicit) {
    const parsed = {
      owner: explicit[1]!,
      repo: explicit[2]!,
      path: explicit[3]!,
      ref: explicit[4]!,
      legacy: false,
    };
    validateRelativePath(parsed.path);
    if (!/^[A-Za-z0-9._/-]{1,200}$/u.test(parsed.ref) || parsed.ref.includes("..")) {
      throw new SkillManagementError(
        "INVALID_SOURCE",
        "GitHub ref contains unsupported characters",
      );
    }
    return parsed;
  }
  const normalized = value.replace(/^https:\/\/github\.com\//iu, "").replace(/\.git(?=@)/iu, "");
  const legacy =
    /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,38}))\/([A-Za-z0-9_.-]{1,100})@([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(
      normalized,
    );
  if (legacy)
    return { owner: legacy[1]!, repo: legacy[2]!, path: legacy[3]!, ref: "HEAD", legacy: true };
  throw new SkillManagementError(
    "INVALID_SOURCE",
    "Supported source syntax is github:OWNER/REPOSITORY/PATH@REF (legacy OWNER/REPOSITORY@SKILL is also accepted)",
  );
}

export function validateRelativePath(path: string) {
  if (
    !path ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("\\") ||
    /^[A-Za-z]:/u.test(path)
  ) {
    throw new SkillManagementError("UNSAFE_PATH", `Unsafe skill path: ${path}`);
  }
  const parts = path.split("/");
  for (const part of parts) {
    let containsControlOrColon = false;
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index);
      if (code <= 0x1f || code === 0x7f || code === 0x3a) containsControlOrColon = true;
    }
    if (
      !part ||
      part === "." ||
      part === ".." ||
      containsControlOrColon ||
      /[. ]$/u.test(part) ||
      WINDOWS_RESERVED.test(part)
    ) {
      throw new SkillManagementError("UNSAFE_PATH", `Unsafe skill path: ${path}`);
    }
  }
}

export function createGitHubSkillSourceResolver(
  fetchImpl: typeof fetch = fetch,
): SkillSourceResolver {
  return async (source) => {
    const parsed = parseSkillSource(source);
    const headers = { accept: "application/vnd.github+json", "user-agent": "OpenGUI" };
    const commitResponse = await fetchImpl(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(parsed.ref)}`,
      { headers },
    );
    if (!commitResponse.ok)
      throw new SkillManagementError(
        "SOURCE_UNAVAILABLE",
        `GitHub revision could not be resolved (${commitResponse.status})`,
      );
    const commit = (await commitResponse.json()) as {
      sha?: unknown;
      commit?: { tree?: { sha?: unknown } };
    };
    if (
      typeof commit.sha !== "string" ||
      !SHA_PATTERN.test(commit.sha) ||
      typeof commit.commit?.tree?.sha !== "string"
    ) {
      throw new SkillManagementError(
        "SOURCE_INVALID",
        "GitHub returned an invalid immutable revision",
      );
    }
    const treeResponse = await fetchImpl(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${commit.commit.tree.sha}?recursive=1`,
      { headers },
    );
    if (!treeResponse.ok)
      throw new SkillManagementError(
        "SOURCE_UNAVAILABLE",
        `GitHub tree could not be read (${treeResponse.status})`,
      );
    const tree = (await treeResponse.json()) as {
      truncated?: boolean;
      tree?: Array<{
        path?: unknown;
        type?: unknown;
        mode?: unknown;
        size?: unknown;
        url?: unknown;
      }>;
    };
    if (tree.truncated)
      throw new SkillManagementError("TREE_TOO_LARGE", "GitHub tree response was truncated");
    const blobs = (tree.tree ?? []).filter(
      (
        item,
      ): item is { path: string; type: "blob"; mode?: unknown; size?: unknown; url?: unknown } =>
        item.type === "blob" && typeof item.path === "string",
    );
    let root = parsed.path;
    if (parsed.legacy) {
      const matches = blobs.filter(
        (item) =>
          item.path === `${parsed.path}/SKILL.md` || item.path.endsWith(`/${parsed.path}/SKILL.md`),
      );
      if (matches.length !== 1)
        throw new SkillManagementError(
          "SOURCE_AMBIGUOUS",
          `Expected exactly one ${parsed.path}/SKILL.md`,
        );
      root = dirname(matches[0]!.path as string).replaceAll("\\", "/");
    }
    validateRelativePath(root);
    const selectedEntries = (tree.tree ?? []).filter(
      (item) =>
        typeof item.path === "string" && (item.path === root || item.path.startsWith(`${root}/`)),
    );
    if (
      selectedEntries.some(
        (item) =>
          (item.type !== "blob" && item.type !== "tree") ||
          (item.type === "blob" && item.mode === "120000"),
      )
    )
      throw new SkillManagementError(
        "UNSAFE_FILE",
        "Skill trees may not contain links or special files",
      );
    const selected = blobs.filter(
      (item) => item.path === `${root}/SKILL.md` || item.path.startsWith(`${root}/`),
    );
    if (!selected.some((item) => item.path === `${root}/SKILL.md`))
      throw new SkillManagementError("SKILL_NOT_FOUND", "Source path does not contain SKILL.md");
    if (selected.length > MAX_FILES)
      throw new SkillManagementError("TREE_TOO_LARGE", "Skill contains too many files");
    const declaredBytes = selected.reduce(
      (total, item) => total + (typeof item.size === "number" ? item.size : MAX_FILE_BYTES + 1),
      0,
    );
    if (declaredBytes > MAX_TREE_BYTES)
      throw new SkillManagementError("TREE_TOO_LARGE", "Skill tree is too large");
    const files: SkillSourceFile[] = [];
    for (const item of selected) {
      const size = typeof item.size === "number" ? item.size : MAX_FILE_BYTES + 1;
      if (size > MAX_FILE_BYTES || !SHA_PATTERN.test(commit.sha))
        throw new SkillManagementError("TREE_TOO_LARGE", "Skill file is too large");
      const response = await fetchImpl(String(item.url), {
        headers: { ...headers, accept: "application/vnd.github.raw+json" },
      });
      if (!response.ok)
        throw new SkillManagementError(
          "SOURCE_UNAVAILABLE",
          `GitHub blob could not be read (${response.status})`,
        );
      files.push({
        path: relativePosix(root, item.path as string),
        contents: new Uint8Array(await response.arrayBuffer()),
      });
    }
    return {
      requested: source,
      canonical: `github:${parsed.owner}/${parsed.repo}/${root}@${commit.sha}`,
      revision: commit.sha,
      path: root,
      files,
    };
  };
}

function relativePosix(root: string, path: string) {
  return path === root ? "" : path.slice(root.length + 1);
}

function validateFiles(files: SkillSourceFile[]) {
  if (!files.length || files.length > MAX_FILES)
    throw new SkillManagementError("TREE_TOO_LARGE", "Skill tree has an unsupported file count");
  let bytes = 0;
  const folded = new Set<string>();
  for (const file of files) {
    validateRelativePath(file.path);
    if ((file.type ?? "file") !== "file" || (file.links ?? 1) !== 1)
      throw new SkillManagementError("UNSAFE_FILE", "Skills may contain regular files only");
    if (file.contents.byteLength > MAX_FILE_BYTES)
      throw new SkillManagementError("TREE_TOO_LARGE", "Skill file is too large");
    bytes += file.contents.byteLength;
    const key = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(key))
      throw new SkillManagementError(
        "PATH_COLLISION",
        "Skill contains a case-folding path collision",
      );
    folded.add(key);
  }
  if (bytes > MAX_TREE_BYTES)
    throw new SkillManagementError("TREE_TOO_LARGE", "Skill tree is too large");
  if (!files.some((file) => file.path === "SKILL.md"))
    throw new SkillManagementError("SKILL_NOT_FOUND", "Skill root must contain SKILL.md");
}

function hashFiles(files: SkillSourceFile[]) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function syncDirectory(path: string) {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      !new Set(["EISDIR", "EINVAL", "ENOTSUP", "EPERM"]).has(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
}

async function inspectTree(root: string): Promise<SkillSourceFile[]> {
  const files: SkillSourceFile[] = [];
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      validateRelativePath(childPath);
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && !info.isFile()) ||
        (info.isFile() && info.nlink !== 1)
      )
        throw new SkillManagementError(
          "UNSAFE_FILE",
          "Installed skill contains links or special files",
        );
      if (info.isDirectory()) await visit(absolute, childPath);
      else
        files.push({
          path: childPath,
          contents: new Uint8Array(await readFile(absolute)),
          links: info.nlink,
        });
    }
  }
  await visit(root, "");
  validateFiles(files);
  return files;
}

function validateLock(value: unknown): SkillLock {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("lock must be an object");
  const input = value as Record<string, unknown>;
  if (
    input.version === 1 &&
    input.skills &&
    typeof input.skills === "object" &&
    !Array.isArray(input.skills)
  ) {
    const skills: Record<string, LockEntry> = {};
    for (const [name, raw] of Object.entries(input.skills as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.computedHash !== "string" && typeof item.skillFolderHash !== "string")
        throw new Error(`invalid v1 lock entry: ${name}`);
      const legacySource = typeof item.source === "string" ? item.source : "";
      const skillPath = typeof item.skillPath === "string" ? item.skillPath : name;
      const source =
        /^[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+$/u.test(legacySource) && skillPath.endsWith("/SKILL.md")
          ? `github:${legacySource}/${skillPath.slice(0, -"/SKILL.md".length)}@HEAD`
          : legacySource;
      skills[name] = {
        name,
        source,
        resolvedSource: source,
        revision: "legacy",
        sourcePath: skillPath,
        contentHash: String(item.computedHash ?? item.skillFolderHash),
        installedAt: typeof item.installedAt === "string" ? item.installedAt : "",
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      };
    }
    return { version: 2, generation: 0, skills, requests: {} };
  }
  if (
    input.version !== 2 ||
    !Number.isSafeInteger(input.generation) ||
    (input.generation as number) < 0 ||
    !input.skills ||
    typeof input.skills !== "object" ||
    Array.isArray(input.skills) ||
    !input.requests ||
    typeof input.requests !== "object" ||
    Array.isArray(input.requests)
  )
    throw new Error("invalid skills lock");
  for (const [name, raw] of Object.entries(input.skills as Record<string, unknown>)) {
    const item = raw as Partial<LockEntry> | null;
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      item.name !== name ||
      typeof item.source !== "string" ||
      typeof item.resolvedSource !== "string" ||
      typeof item.revision !== "string" ||
      typeof item.sourcePath !== "string" ||
      typeof item.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.contentHash) ||
      typeof item.installedAt !== "string" ||
      typeof item.updatedAt !== "string"
    )
      throw new Error(`invalid skills lock entry: ${name}`);
  }
  for (const [requestId, raw] of Object.entries(input.requests as Record<string, unknown>)) {
    const item = raw as { operation?: unknown; name?: unknown; generation?: unknown } | null;
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      (item.operation !== "install" &&
        item.operation !== "update" &&
        item.operation !== "remove") ||
      typeof item.name !== "string" ||
      !Number.isSafeInteger(item.generation) ||
      !/^[A-Za-z0-9_-]{8,128}$/u.test(requestId)
    )
      throw new Error(`invalid skills request record: ${requestId}`);
  }
  return value as SkillLock;
}

function emptyLock(): SkillLock {
  return { version: 2, generation: 0, skills: {}, requests: {} };
}

export class SkillsManager {
  readonly #resolver: SkillSourceResolver;
  readonly #homeDirectory: string;
  readonly #authorizeManagement: (
    actor: DurableActor | undefined,
    scope: SkillScope,
    projectDirectory?: string,
  ) => Promise<void>;
  #queue = Promise.resolve();

  constructor(options: {
    resolver?: SkillSourceResolver;
    homeDirectory: string;
    authorizeManagement?: (
      actor: DurableActor | undefined,
      scope: SkillScope,
      projectDirectory?: string,
    ) => Promise<void>;
  }) {
    this.#resolver = options.resolver ?? createGitHubSkillSourceResolver();
    this.#homeDirectory = resolve(options.homeDirectory);
    this.#authorizeManagement = options.authorizeManagement ?? (async () => undefined);
  }

  sources() {
    return supportedSkillSources();
  }

  #paths(scope: SkillScope, projectDirectory?: string) {
    if (scope === "project" && !projectDirectory)
      throw new SkillManagementError(
        "PROJECT_REQUIRED",
        "Project scope requires a project directory",
      );
    const base =
      scope === "host" ? join(this.#homeDirectory, ".agents") : resolve(projectDirectory!);
    return {
      root: scope === "host" ? join(base, "skills") : join(base, ".agents", "skills"),
      lock: scope === "host" ? join(base, "skills-lock.json") : join(base, "skills-lock.json"),
      legacyLock: scope === "host" ? join(base, ".skill-lock.json") : undefined,
    };
  }

  async #openLock(path: string, legacyPath?: string) {
    let fallback = emptyLock();
    let currentExists = true;
    try {
      await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      currentExists = false;
    }
    if (!currentExists && legacyPath) {
      let legacyContents: string | undefined;
      try {
        legacyContents = await readFile(legacyPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (legacyContents !== undefined) {
        try {
          fallback = validateLock(JSON.parse(legacyContents));
        } catch {
          // Other Skills installers also use ~/.agents/.skill-lock.json with
          // incompatible schemas. It is only a migration hint; the current
          // OpenGUI skills-lock.json remains the authoritative strict lock.
          fallback = emptyLock();
        }
      }
    }
    return openDurableJsonTransaction(path, {
      fallback,
      validate: validateLock,
      failOnInvalid: true,
      mode: 0o600,
    });
  }

  async list(scope: SkillScope, projectDirectory?: string): Promise<SkillInstallation[]> {
    const paths = this.#paths(scope, projectDirectory);
    const lock = await this.#openLock(paths.lock, paths.legacyLock);
    try {
      const state = lock.current();
      const result: SkillInstallation[] = [];
      let entries: string[] = [];
      try {
        entries = await readdir(paths.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const name of entries.sort()) {
        const location = join(paths.root, name);
        let info;
        try {
          info = await lstat(location);
        } catch {
          continue;
        }
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const loaded = loadSkillsFromDir(location, scope === "host" ? "host" : "project");
        const skill = loaded.skills.find((item) => item.baseDir === resolve(location));
        if (!skill) continue;
        const managed = state.skills[name];
        let modified = false;
        if (managed) {
          try {
            modified = hashFiles(await inspectTree(location)) !== managed.contentHash;
          } catch {
            modified = true;
          }
        }
        result.push({
          name: skill.name,
          description: skill.description,
          manual: skill.disableModelInvocation,
          scope,
          location,
          managed: Boolean(managed),
          modified,
          generation: state.generation,
          ...(managed
            ? {
                source: managed.source,
                resolvedSource: managed.resolvedSource,
                revision: managed.revision,
              }
            : {}),
        });
      }
      return result;
    } finally {
      await lock.close();
    }
  }

  install(input: {
    source: string;
    scope: SkillScope;
    projectDirectory?: string;
    requestId: string;
    expectedGeneration?: number;
    actor?: DurableActor;
  }) {
    return this.#enqueue(() => this.#publish("install", input));
  }
  update(input: {
    name: string;
    scope: SkillScope;
    projectDirectory?: string;
    requestId: string;
    expectedGeneration?: number;
    actor?: DurableActor;
  }) {
    return this.#enqueue(() => this.#publish("update", input));
  }
  remove(input: {
    name: string;
    scope: SkillScope;
    projectDirectory?: string;
    requestId: string;
    expectedGeneration?: number;
    actor?: DurableActor;
  }) {
    return this.#enqueue(() => this.#remove(input));
  }
  #enqueue<T>(operation: () => Promise<T>) {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #publish(
    operation: "install" | "update",
    input: {
      source?: string;
      name?: string;
      scope: SkillScope;
      projectDirectory?: string;
      requestId: string;
      expectedGeneration?: number;
      actor?: DurableActor;
    },
  ): Promise<SkillInstallation> {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(input.requestId))
      throw new SkillManagementError(
        "INVALID_REQUEST_ID",
        "requestId must be 8-128 letters, numbers, underscores, or hyphens",
      );
    await this.#authorizeManagement(input.actor, input.scope, input.projectDirectory);
    const paths = this.#paths(input.scope, input.projectDirectory);
    const lock = await this.#openLock(paths.lock, paths.legacyLock);
    let stage = "";
    let backup = "";
    let destination = "";
    let published = false;
    let committedResult: SkillInstallation | undefined;
    try {
      const current = lock.current();
      if (input.expectedGeneration !== undefined && input.expectedGeneration !== current.generation)
        throw new SkillManagementError(
          "GENERATION_CONFLICT",
          "Skills generation changed; refresh and retry",
        );
      const replay = current.requests[input.requestId];
      if (replay) {
        const entry = current.skills[replay.name];
        const location = join(paths.root, replay.name);
        const skill = loadSkillsFromDir(
          location,
          input.scope === "host" ? "host" : "project",
        ).skills.find((item) => item.name === replay.name);
        if (!entry || !skill)
          throw new SkillManagementError(
            "IDEMPOTENCY_CONFLICT",
            "Prior request result is no longer installed",
          );
        return {
          name: skill.name,
          description: skill.description,
          manual: skill.disableModelInvocation,
          scope: input.scope,
          location,
          managed: true,
          modified: hashFiles(await inspectTree(location)) !== entry.contentHash,
          generation: current.generation,
          source: entry.source,
          resolvedSource: entry.resolvedSource,
          revision: entry.revision,
        };
      }
      let source = input.source;
      if (operation === "update") {
        if (!input.name || !current.skills[input.name])
          throw new SkillManagementError("NOT_MANAGED", "Only managed skills can be updated");
        const existing = current.skills[input.name]!;
        destination = join(paths.root, input.name);
        if (hashFiles(await inspectTree(destination)) !== existing.contentHash)
          throw new SkillManagementError("LOCALLY_MODIFIED", "Local modifications block update");
        source = existing.source;
      }
      const resolvedSource = await this.#resolver(source!);
      validateFiles(resolvedSource.files);
      stage = join(paths.root, `.opengui-stage-${randomUUID()}`);
      await mkdir(stage, { recursive: true });
      for (const file of resolvedSource.files) {
        const path = join(stage, ...file.path.split("/"));
        await mkdir(dirname(path), { recursive: true });
        const handle = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          await handle.writeFile(file.contents);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      const stagedFiles = await inspectTree(stage);
      const loaded = loadSkillsFromDir(stage, input.scope === "host" ? "host" : "project");
      const skill = loaded.skills.find((item) => item.baseDir === resolve(stage));
      if (!skill)
        throw new SkillManagementError(
          "INVALID_SKILL",
          loaded.diagnostics[0]?.message ?? "SKILL.md is invalid",
        );
      if (operation === "update" && skill.name !== input.name)
        throw new SkillManagementError("NAME_CHANGED", "An update may not change the skill name");
      const foldedName = skill.name.normalize("NFC").toLocaleLowerCase("en-US");
      const collidingName = (await readdir(paths.root)).find(
        (name) =>
          name !== skill.name && name.normalize("NFC").toLocaleLowerCase("en-US") === foldedName,
      );
      if (collidingName)
        throw new SkillManagementError(
          "PATH_COLLISION",
          `Skill name collides with existing directory: ${collidingName}`,
        );
      destination = join(paths.root, skill.name);
      const existingEntry = current.skills[skill.name];
      try {
        const existingInfo = await lstat(destination);
        if (!existingInfo.isDirectory() || existingInfo.isSymbolicLink())
          throw new SkillManagementError(
            "UNSAFE_DESTINATION",
            "Skill destination is not a regular directory",
          );
        if (!existingEntry)
          throw new SkillManagementError(
            "ALREADY_EXISTS",
            "An unmanaged skill already exists with this name",
          );
        if (hashFiles(await inspectTree(destination)) !== existingEntry.contentHash)
          throw new SkillManagementError(
            "LOCALLY_MODIFIED",
            "Local modifications block replacement",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.#authorizeManagement(input.actor, input.scope, input.projectDirectory);
      backup = `${destination}.backup-${randomUUID()}`;
      try {
        await rename(destination, backup);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        backup = "";
      }
      await rename(stage, destination);
      stage = "";
      published = true;
      await syncDirectory(paths.root);
      const now = new Date().toISOString();
      const nextGeneration = current.generation + 1;
      const entry: LockEntry = {
        name: skill.name,
        source: source!,
        resolvedSource: resolvedSource.canonical,
        revision: resolvedSource.revision,
        sourcePath: resolvedSource.path,
        contentHash: hashFiles(stagedFiles),
        installedAt: existingEntry?.installedAt || now,
        updatedAt: now,
      };
      committedResult = {
        name: skill.name,
        description: skill.description,
        manual: skill.disableModelInvocation,
        scope: input.scope,
        location: destination,
        managed: true,
        modified: false,
        generation: nextGeneration,
        source: entry.source,
        resolvedSource: entry.resolvedSource,
        revision: entry.revision,
      };
      await lock.replace({
        ...current,
        generation: nextGeneration,
        skills: { ...current.skills, [skill.name]: entry },
        requests: {
          ...current.requests,
          [input.requestId]: { operation, name: skill.name, generation: nextGeneration },
        },
      });
      await rm(backup, { recursive: true, force: true });
      backup = "";
      await syncDirectory(paths.root);
      return committedResult;
    } catch (error) {
      if (error instanceof DurableJsonCommitError && error.committed && committedResult) {
        published = false;
        await rm(backup, { recursive: true, force: true });
        backup = "";
        return committedResult;
      }
      if (published) {
        await rm(destination, { recursive: true, force: true });
        if (backup) await rename(backup, destination);
      }
      throw error;
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true });
      if (backup) await rm(backup, { recursive: true, force: true });
      await lock.close();
    }
  }

  async #remove(input: {
    name: string;
    scope: SkillScope;
    projectDirectory?: string;
    requestId: string;
    expectedGeneration?: number;
    actor?: DurableActor;
  }) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.name))
      throw new SkillManagementError("INVALID_NAME", "Invalid skill name");
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(input.requestId))
      throw new SkillManagementError("INVALID_REQUEST_ID", "Invalid requestId");
    await this.#authorizeManagement(input.actor, input.scope, input.projectDirectory);
    const paths = this.#paths(input.scope, input.projectDirectory);
    const lock = await this.#openLock(paths.lock, paths.legacyLock);
    let backup = "";
    try {
      const current = lock.current();
      if (input.expectedGeneration !== undefined && input.expectedGeneration !== current.generation)
        throw new SkillManagementError(
          "GENERATION_CONFLICT",
          "Skills generation changed; refresh and retry",
        );
      if (current.requests[input.requestId]) return;
      const entry = current.skills[input.name];
      if (!entry)
        throw new SkillManagementError("NOT_MANAGED", "Only managed skills can be removed");
      const destination = join(paths.root, input.name);
      if (hashFiles(await inspectTree(destination)) !== entry.contentHash)
        throw new SkillManagementError("LOCALLY_MODIFIED", "Local modifications block removal");
      await this.#authorizeManagement(input.actor, input.scope, input.projectDirectory);
      backup = `${destination}.removed-${randomUUID()}`;
      await rename(destination, backup);
      await syncDirectory(paths.root);
      const generation = current.generation + 1;
      const skills = { ...current.skills };
      delete skills[input.name];
      await lock.replace({
        ...current,
        generation,
        skills,
        requests: {
          ...current.requests,
          [input.requestId]: { operation: "remove", name: input.name, generation },
        },
      });
      await rm(backup, { recursive: true, force: true });
      backup = "";
      await syncDirectory(paths.root);
    } catch (error) {
      if (error instanceof DurableJsonCommitError && error.committed) {
        await rm(backup, { recursive: true, force: true });
        backup = "";
        return;
      }
      if (backup) await rename(backup, join(paths.root, input.name));
      throw error;
    } finally {
      if (backup) await rm(backup, { recursive: true, force: true });
      await lock.close();
    }
  }
}
