import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { createHash } from "node:crypto";
import type { BackendServiceContext } from "./services/index.ts";
import { getHarnessInventories } from "./harness-inventory.ts";

interface IpcSender {
  send(channel: string, data: unknown): void;
}

interface IpcEvent {
  sender: IpcSender;
}

type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;

interface InstalledSkillRecord {
  name: string;
  slug: string;
  description?: string;
  location: string;
  content?: string;
  source?: string;
  remoteKey?: string;
  pluginName?: string;
  sourceType?: string;
  sourceUrl?: string;
  skillPath?: string;
  skillFolderHash?: string;
  computedHash?: string;
  scope?: string;
}

interface IpcHandlerRegistry {
  handle(channel: string, handler: Handler): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseCommand(command: string) {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!matches) return [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ""));
}

function spawnDetached(command: string, args: string[], cwd?: string) {
  const child = spawn(command, args, {
    cwd,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

function isWebUrl(url: unknown) {
  return typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"));
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseSkillFrontmatter(text: string) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return { name: basename(process.cwd()), description: "" };
  const frontmatter = match[1] ?? "";
  const nameMatch = frontmatter.match(/^name\s*:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description\s*:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1]?.trim() || "" : "",
    description: descMatch ? descMatch[1]?.trim() || "" : "",
  };
}

async function readSkillsLock(lockPath: string) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf-8")) as unknown;
    if (!isPlainObject(parsed) || !isPlainObject(parsed.skills)) return {};
    return parsed.skills;
  } catch {
    return {};
  }
}

function toSkillSlug(name: unknown) {
  return (typeof name === "string" ? name : "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeLockSource(source: unknown) {
  if (!source || typeof source !== "string") return undefined;
  let value = source.trim();
  if (value.startsWith("https://github.com/")) value = value.replace("https://github.com/", "");
  value = value.replace(/\.git$/, "").toLowerCase();
  if (value.includes("github.com/")) value = value.split("github.com/").pop() ?? value;
  return value;
}

async function scanSkillsDir(dir: string | null, lockSkills: Record<string, unknown> = {}) {
  const skills: InstalledSkillRecord[] = [];
  if (!dir || !existsSync(dir)) return skills;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    const skillMdPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    try {
      const content = await readFile(skillMdPath, "utf-8");
      const { name, description } = parseSkillFrontmatter(content);
      const skillName = name || entry.name;
      const slug = toSkillSlug(skillName || entry.name);
      const lockEntryValue = lockSkills[skillName] ?? lockSkills[entry.name] ?? lockSkills[slug];
      const lockEntry = isPlainObject(lockEntryValue) ? lockEntryValue : {};
      const source = normalizeLockSource(lockEntry.source);
      skills.push({
        name: skillName,
        slug,
        description,
        location: skillMdPath,
        content,
        source,
        remoteKey: source ? `${source}@${slug}` : undefined,
        pluginName: typeof lockEntry.pluginName === "string" ? lockEntry.pluginName : undefined,
        sourceType: typeof lockEntry.sourceType === "string" ? lockEntry.sourceType : undefined,
        sourceUrl: typeof lockEntry.sourceUrl === "string" ? lockEntry.sourceUrl : undefined,
        skillPath: typeof lockEntry.skillPath === "string" ? lockEntry.skillPath : undefined,
        skillFolderHash:
          typeof lockEntry.skillFolderHash === "string" ? lockEntry.skillFolderHash : undefined,
        computedHash:
          typeof lockEntry.computedHash === "string" ? lockEntry.computedHash : undefined,
      });
    } catch {
      // Ignore malformed skills.
    }
  }
  return skills;
}

const SKILLS_API_BASE = "https://skills.sh/api/v1";
const SKILLS_LEGACY_API_BASE = "https://skills.sh";

function normalizeLegacySkill(skill: Record<string, unknown>) {
  const sourceValue = typeof skill.source === "string" ? skill.source : "";
  const nameValue = typeof skill.name === "string" ? skill.name : "";
  const skillIdValue = typeof skill.skillId === "string" ? skill.skillId : "";
  const slugValue = typeof skill.slug === "string" ? skill.slug : "";
  const id =
    (typeof skill.id === "string" ? skill.id : "") ||
    [sourceValue, skillIdValue || slugValue || nameValue].filter(Boolean).join("/");
  const parts = id.split("/");
  const slug = skillIdValue || slugValue || parts.at(-1) || nameValue;
  const source = sourceValue || parts.slice(0, -1).join("/");
  return {
    id,
    slug,
    name: nameValue || slug,
    source,
    installs: typeof skill.installs === "number" ? skill.installs : 0,
    sourceType: source.includes("/") ? "github" : "well-known",
    installUrl: source.includes("/")
      ? `https://github.com/${source}`
      : source
        ? `https://${source}`
        : null,
    url: `https://skills.sh/${id}`,
  };
}

function normalizeLegacySearch(data: unknown) {
  const record = isPlainObject(data) ? data : {};
  const rawSkills = Array.isArray(record.skills) ? record.skills : [];
  const skills = rawSkills
    .filter((skill): skill is Record<string, unknown> => isPlainObject(skill))
    .map(normalizeLegacySkill);
  return {
    data: skills,
    query: typeof record.query === "string" ? record.query : "",
    searchType: typeof record.searchType === "string" ? record.searchType : "fuzzy",
    count: typeof record.count === "number" ? record.count : skills.length,
    durationMs:
      typeof record.durationMs === "number"
        ? record.durationMs
        : typeof record.duration_ms === "number"
          ? record.duration_ms
          : 0,
  };
}

async function skillsFetch(path: string, apiKey: unknown) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (typeof apiKey === "string" && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${SKILLS_API_BASE}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`skills.sh API ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

async function legacySkillsSearch(query: unknown, limit: unknown) {
  const params = new URLSearchParams({
    q: typeof query === "string" ? query : "skill",
    limit: String(typeof limit === "number" ? limit : 50),
  });
  const res = await fetch(`${SKILLS_LEGACY_API_BASE}/api/search?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`skills.sh search API ${res.status}: ${body || res.statusText}`);
  }
  return normalizeLegacySearch(await res.json());
}

async function legacySkillDownload(source: unknown, slug: unknown) {
  if (typeof source !== "string" || typeof slug !== "string") return null;
  const [owner, repo] = source.split("/");
  if (!owner || !repo) return null;
  const res = await fetch(
    `${SKILLS_LEGACY_API_BASE}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) return null;
  return res.json();
}

function parseInstallSource(source: unknown) {
  if (typeof source !== "string") throw new Error("Plugin source must be a string.");
  let value = source.trim();
  if (!value) throw new Error("Plugin source is required.");
  value = value.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");

  const [repoPart, slugPart] = value.split("@");
  const parts = (repoPart ?? "").split("/").filter(Boolean);
  const owner = parts[0];
  const repo = parts[1];
  const slug = slugPart || parts[2];
  if (!owner || !repo || !slug) {
    throw new Error("Use source format owner/repo@skill-name.");
  }
  return { source: `${owner}/${repo}`, owner, repo, slug };
}

function safeRelativePath(path: unknown) {
  if (typeof path !== "string" || !path.trim()) throw new Error("Downloaded skill has no path.");
  const normalized = normalize(path).replace(/^([/\\])+/, "");
  if (
    isAbsolute(path) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("..\\")
  ) {
    throw new Error(`Unsafe skill file path: ${path}`);
  }
  return normalized;
}

function hashSkillFiles(files: Array<{ path: string; contents: string }>) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function writeSkillsLock(
  lockPath: string,
  slug: string,
  entry: Record<string, unknown> | null,
) {
  let lock: Record<string, unknown> = { version: 1, skills: {} };
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf-8")) as unknown;
    if (isPlainObject(parsed)) lock = parsed;
  } catch {
    // Create a new lock file below.
  }

  const skills = isPlainObject(lock.skills) ? { ...lock.skills } : {};
  if (entry) skills[slug] = entry;
  else delete skills[slug];
  lock.skills = skills;
  if (typeof lock.version !== "number") lock.version = 1;
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
}

async function installSkillFromSource(source: unknown, directory: unknown, globalScope: unknown) {
  const parsedSource = parseInstallSource(source);
  const downloaded = await legacySkillDownload(parsedSource.source, parsedSource.slug);
  const downloadedRecord = isPlainObject(downloaded) ? downloaded : null;
  const rawFiles = Array.isArray(downloadedRecord?.files) ? downloadedRecord.files : [];
  const files = rawFiles
    .filter((file): file is Record<string, unknown> => isPlainObject(file))
    .map((file) => ({
      path: safeRelativePath(file.path),
      contents: typeof file.contents === "string" ? file.contents : "",
    }));
  if (files.length === 0)
    throw new Error(`No files found for ${parsedSource.source}@${parsedSource.slug}.`);

  const projectDirectory = typeof directory === "string" && directory ? directory : homedir();
  const baseDir = globalScope
    ? join(homedir(), ".agents", "skills")
    : join(projectDirectory, ".agents", "skills");
  const targetDir = join(baseDir, parsedSource.slug);
  await mkdir(targetDir, { recursive: true });

  for (const file of files) {
    const targetPath = join(targetDir, file.path);
    const relativeTarget = relative(targetDir, targetPath);
    if (relativeTarget === "" || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
      throw new Error(`Unsafe skill file path: ${file.path}`);
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.contents, "utf-8");
  }

  const firstSkillFile = files.find((file) => basename(file.path) === "SKILL.md") ?? files[0]!;
  const computedHash =
    typeof downloadedRecord?.hash === "string" ? downloadedRecord.hash : hashSkillFiles(files);
  const now = new Date().toISOString();
  const lockPath = globalScope
    ? join(homedir(), ".agents", ".skill-lock.json")
    : join(projectDirectory, "skills-lock.json");
  await writeSkillsLock(lockPath, parsedSource.slug, {
    source: parsedSource.source,
    sourceType: "github",
    sourceUrl: `https://github.com/${parsedSource.source}.git`,
    skillPath: `${parsedSource.slug}/${firstSkillFile.path}`,
    computedHash,
    installedAt: now,
    updatedAt: now,
  });
}

async function findInstalledSkill(skillName: unknown, directory: unknown, globalScope: unknown) {
  const projectDirectory = typeof directory === "string" && directory ? directory : null;
  const globalSkillsDir = join(homedir(), ".agents", "skills");
  const projectSkillsDir = projectDirectory ? join(projectDirectory, ".agents", "skills") : null;
  const projectLock = projectDirectory
    ? await readSkillsLock(join(projectDirectory, "skills-lock.json"))
    : {};
  const globalLock = await readSkillsLock(join(homedir(), ".agents", ".skill-lock.json"));
  const projectSkills = (await scanSkillsDir(projectSkillsDir, projectLock)).map((skill) => ({
    ...skill,
    scope: "project",
  }));
  const globalSkills = (await scanSkillsDir(globalSkillsDir, globalLock)).map((skill) => ({
    ...skill,
    scope: "global",
  }));
  const wantedScope = globalScope ? "global" : "project";
  const wanted = typeof skillName === "string" ? skillName.toLowerCase() : "";
  return [...projectSkills, ...globalSkills].find(
    (skill) =>
      skill.scope === wantedScope &&
      (String(skill.name).toLowerCase() === wanted || String(skill.slug).toLowerCase() === wanted),
  );
}

function openExternal(url: string) {
  if (!isWebUrl(url)) return;
  if (process.platform === "darwin") spawnDetached("open", [url]);
  else if (process.platform === "win32") spawnDetached("cmd.exe", ["/c", "start", "", url]);
  else spawnDetached("xdg-open", [url]);
}

function openPath(path: string) {
  if (process.platform === "darwin") spawnDetached("open", [path]);
  else if (process.platform === "win32") spawnDetached("explorer.exe", [path]);
  else spawnDetached("xdg-open", [path]);
}

async function runPicker(command: string[]) {
  const [file, ...args] = command;
  if (!file) return null;

  let proc;
  try {
    proc = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }

  const stdoutChunks: Buffer[] = [];
  proc.stdout?.on("data", (chunk) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  });

  const timeout = setTimeout(() => proc.kill(), 120_000);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code) => resolve(code));
    });
    if (exitCode !== 0) return null;
    return Buffer.concat(stdoutChunks).toString("utf8").trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function chooseDirectory() {
  if (process.platform === "darwin") {
    return await runPicker([
      "osascript",
      "-e",
      'POSIX path of (choose folder with prompt "Open project folder")',
    ]);
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Open project folder'",
      "if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath }",
    ].join("; ");
    return await runPicker(["powershell.exe", "-NoProfile", "-Command", script]);
  }

  for (const picker of [
    ["zenity", "--file-selection", "--directory", "--title=Open project folder"],
    ["kdialog", "--getexistingdirectory", homedir(), "Open project folder"],
    ["yad", "--file-selection", "--directory", "--title=Open project folder"],
  ]) {
    const directory = await runPicker(picker);
    if (directory) return directory;
  }

  return null;
}

function openTerminal(dirPath: string, command = "") {
  if (!existsSync(dirPath)) return;
  const parts = parseCommand(command);
  if (parts.length > 0) {
    const [cmd, ...args] = parts;
    if (!cmd) return;
    spawnDetached(cmd, args, dirPath);
    return;
  }
  if (process.platform === "darwin") spawnDetached("open", ["-a", "Terminal", dirPath]);
  else if (process.platform === "win32")
    spawnDetached("cmd.exe", ["/c", "start", "cmd.exe", "/k", `cd /d "${dirPath}"`]);
  else spawnDetached(process.env.TERMINAL || "x-terminal-emulator", [], dirPath);
}

export function registerShellIpcHandlers(input: {
  ipcMain: IpcHandlerRegistry;
  broadcast: (channel: string, data: unknown) => void;
  services: BackendServiceContext;
}) {
  const { ipcMain, broadcast, services } = input;
  const emitSettingsChange = (key: string, value: unknown) =>
    broadcast("settings:changed", { key, value });

  ipcMain.handle("settings:get-all", () => services.storage.getAllSettings());
  ipcMain.handle("settings:get", (_event, key) =>
    typeof key === "string" ? services.storage.getSetting(key) : null,
  );
  ipcMain.handle("settings:set", async (_event, key, value) => {
    if (typeof key !== "string" || typeof value !== "string") return false;
    const success = await services.storage.setSetting(key, value);
    if (success) emitSettingsChange(key, value);
    return success;
  });
  ipcMain.handle("settings:remove", async (_event, key) => {
    if (typeof key !== "string") return false;
    const success = await services.storage.removeSetting(key);
    if (success) emitSettingsChange(key, null);
    return success;
  });
  ipcMain.handle("settings:merge", async (_event, entries) => {
    if (!isPlainObject(entries)) return false;
    const normalizedEntries = Object.fromEntries(
      Object.entries(entries).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
    const success = await services.storage.mergeSettings(normalizedEntries);
    if (success) {
      for (const [key, value] of Object.entries(normalizedEntries)) emitSettingsChange(key, value);
    }
    return success;
  });

  ipcMain.handle("window:minimize", () => undefined);
  ipcMain.handle("window:maximize", () => undefined);
  ipcMain.handle("window:close", () => undefined);
  ipcMain.handle("window:isMaximized", () => false);
  ipcMain.handle("window:detachProject", () => undefined);
  ipcMain.handle("window:getDetachedProjects", () => []);
  ipcMain.handle("platform:get", () => process.platform);
  ipcMain.handle("platform:homeDir", () => homedir());
  ipcMain.handle("platform:harnessInventory", () => getHarnessInventories());
  ipcMain.handle(
    "platform:locale",
    () => Intl.DateTimeFormat().resolvedOptions().locale || "en-US",
  );
  ipcMain.handle("app:isPackaged", () => false);
  ipcMain.handle("dialog:openDirectory", () => chooseDirectory());
  ipcMain.handle("shell:openExternal", (_event, url) =>
    openExternal(typeof url === "string" ? url : ""),
  );
  ipcMain.handle("shell:openInFileBrowser", (_event, dirPath, command = "") => {
    const dir = typeof dirPath === "string" ? dirPath : "";
    if (!dir) return;
    if (typeof command === "string" && command) {
      const parts = parseCommand(command);
      if (parts.length > 0) {
        const [cmd, ...args] = parts;
        if (!cmd) return;
        spawnDetached(cmd, args.length > 0 ? args : [dir], dir);
        return;
      }
    }
    openPath(dir);
  });
  ipcMain.handle("shell:openInTerminal", (_event, dirPath, command = "") =>
    openTerminal(
      typeof dirPath === "string" ? dirPath : "",
      typeof command === "string" ? command : "",
    ),
  );

  ipcMain.handle("skills:marketplace:list", async (_event, _view, page, perPage) => {
    try {
      const data = await legacySkillsSearch("skill", perPage || 50);
      return {
        success: true,
        data: {
          data: data.data,
          pagination: {
            page: typeof page === "number" ? page : 0,
            perPage: typeof perPage === "number" ? perPage : data.data.length,
            total: data.data.length,
            totalPages: 1,
          },
        },
      };
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  });

  ipcMain.handle("skills:marketplace:search", async (_event, query, limit) => {
    try {
      return { success: true, data: await legacySkillsSearch(query, limit || 50) };
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  });

  ipcMain.handle("skills:marketplace:detail", async (_event, source, slug, apiKey) => {
    try {
      const legacy = await legacySkillDownload(source, slug);
      if (legacy) {
        const legacyRecord = isPlainObject(legacy) ? legacy : {};
        const sourceText = String(source);
        const slugText = String(slug);
        return {
          success: true,
          data: {
            id: `${sourceText}/${slugText}`,
            source: sourceText,
            slug: slugText,
            readme: null,
            manifest: null,
            files: Array.isArray(legacyRecord.files) ? legacyRecord.files : null,
          },
        };
      }

      const data = await skillsFetch(
        `/skills/${encodeURIComponent(String(source))}/${encodeURIComponent(String(slug))}`,
        apiKey,
      );
      return { success: true, data };
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  });

  ipcMain.handle("skills:marketplace:audit", async (_event, source, slug, apiKey) => {
    try {
      if (!apiKey)
        return {
          success: true,
          data: {
            id: `${String(source)}/${String(slug)}`,
            source: String(source),
            slug: String(slug),
            audits: [],
          },
        };
      const data = await skillsFetch(
        `/skills/audit/${encodeURIComponent(String(source))}/${encodeURIComponent(String(slug))}`,
        apiKey,
      );
      return { success: true, data };
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  });

  ipcMain.handle("skills:marketplace:curated", async () => {
    try {
      const data = await legacySkillsSearch("official", 50);
      return {
        success: true,
        data: {
          data: [
            {
              owner: "skills.sh",
              totalInstalls: data.data.reduce((sum, skill) => sum + (skill.installs || 0), 0),
              featuredRepo: "search",
              featuredPlugin: data.data[0]?.name || "Skills",
              skills: data.data,
            },
          ],
          totalOwners: 1,
          totalPlugins: data.data.length,
          generatedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  });

  ipcMain.handle("skills:check-cli", () => {
    return { success: true, data: { available: true, command: "built-in" } };
  });

  ipcMain.handle("skills:install", async (_event, source, directory, globalScope) => {
    try {
      broadcast("skills:install-progress", {
        chunk: `Installing ${String(source)}\n`,
        type: "system",
      });
      await installSkillFromSource(source, directory, globalScope);
      broadcast("skills:install-progress", { chunk: "Installation complete\n", type: "system" });
      return { success: true, exitCode: 0 };
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  });

  ipcMain.handle("skills:remove", async (_event, skillName, directory, globalScope) => {
    try {
      const installed = await findInstalledSkill(skillName, directory, globalScope);
      if (!installed) return { success: false, error: `Plugin not found: ${String(skillName)}` };
      await rm(dirname(String(installed.location)), { recursive: true, force: true });
      const lockPath = globalScope
        ? join(homedir(), ".agents", ".skill-lock.json")
        : join(
            typeof directory === "string" && directory ? directory : homedir(),
            "skills-lock.json",
          );
      await writeSkillsLock(lockPath, String(installed.slug || installed.name), null);
      return { success: true, exitCode: 0 };
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  });

  ipcMain.handle("skills:update", async (_event, skillName, directory, globalScope) => {
    try {
      const installed = await findInstalledSkill(skillName, directory, globalScope);
      if (!installed?.source || !installed?.slug) {
        return { success: false, error: `Plugin has no update source: ${String(skillName)}` };
      }
      await installSkillFromSource(
        `${String(installed.source)}@${String(installed.slug)}`,
        directory,
        globalScope,
      );
      return { success: true, exitCode: 0 };
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  });

  ipcMain.handle("skills:list-installed", async (_event, directory) => {
    try {
      const globalSkillsDir = join(homedir(), ".agents", "skills");
      const projectDirectory = typeof directory === "string" && directory ? directory : null;
      const projectSkillsDir = projectDirectory
        ? join(projectDirectory, ".agents", "skills")
        : null;
      const shouldScanProject =
        projectSkillsDir !== null && normalize(projectSkillsDir) !== normalize(globalSkillsDir);
      const projectLock = shouldScanProject
        ? await readSkillsLock(join(projectDirectory ?? "", "skills-lock.json"))
        : {};
      const globalLock = await readSkillsLock(join(homedir(), ".agents", ".skill-lock.json"));
      const projectSkills = (
        await scanSkillsDir(shouldScanProject ? projectSkillsDir : null, projectLock)
      ).map((skill) => ({ ...skill, scope: "project" }));
      const globalSkills = (await scanSkillsDir(globalSkillsDir, globalLock)).map((skill) => ({
        ...skill,
        scope: "global",
      }));
      const seen = new Set<string>();
      const deduped = [];
      for (const skill of [...projectSkills, ...globalSkills]) {
        const key = skill.remoteKey || `${skill.scope}:${skill.location}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(skill);
      }
      return { success: true, data: deduped };
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  });

  ipcMain.handle("agent-backends:restart", async () => {
    const results: Record<string, { success: boolean; error?: string }> = {};
    for (const harnessId of services.harnesses.getManagedHarnessIds()) {
      try {
        await services.harnesses.restartHarness(harnessId);
        results[harnessId] = { success: true };
      } catch (error) {
        results[harnessId] = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { success: true, data: results };
  });
}
