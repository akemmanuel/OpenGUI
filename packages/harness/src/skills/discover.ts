import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { parseFrontmatter, validateDescription, validateSkillName } from "./parse.ts";
import type { LoadSkillsResult, Skill, SkillDiagnostic, SkillSource } from "./types.ts";

const AGENTS_SKILLS = join(".agents", "skills");
const MAX_DEPTH = 6;

function canonicalize(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function loadSkillFromFile(
  filePath: string,
  source: SkillSource,
): {
  skill: Skill | null;
  diagnostics: SkillDiagnostic[];
} {
  const diagnostics: SkillDiagnostic[] = [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: error instanceof Error ? error.message : "failed to read skill file",
      path: filePath,
    });
    return { skill: null, diagnostics };
  }

  const { frontmatter } = parseFrontmatter(raw);
  const descriptionErrors = validateDescription(frontmatter.description);
  if (descriptionErrors.length > 0) {
    for (const message of descriptionErrors) {
      diagnostics.push({ type: "error", message, path: filePath });
    }
    return { skill: null, diagnostics };
  }

  const parentDirName = dirname(filePath).split(sep).filter(Boolean).at(-1) ?? "skill";
  const name =
    typeof frontmatter.name === "string" && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : parentDirName;

  for (const message of validateSkillName(name)) {
    diagnostics.push({ type: "warning", message, path: filePath });
  }

  if (typeof frontmatter.name === "string" && frontmatter.name.trim() !== parentDirName) {
    diagnostics.push({
      type: "warning",
      message: `name "${frontmatter.name}" does not match parent directory "${parentDirName}"`,
      path: filePath,
    });
  }

  return {
    skill: {
      name,
      description: String(frontmatter.description).trim(),
      filePath: resolve(filePath),
      baseDir: dirname(resolve(filePath)),
      source,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    },
    diagnostics,
  };
}

/**
 * Discover Agent Skills directories containing SKILL.md.
 * Root-level .md files are ignored (`.agents/skills` convention).
 */
export function loadSkillsFromDir(dir: string, source: SkillSource): LoadSkillsResult {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const root = resolve(dir);
  if (!isDirectory(root)) return { skills, diagnostics };

  const visit = (current: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      diagnostics.push({
        type: "warning",
        message: error instanceof Error ? error.message : "failed to read skills directory",
        path: current,
      });
      return;
    }

    const skillMd = join(current, "SKILL.md");
    if (existsSync(skillMd) && !isDirectory(skillMd) && !lstatSync(skillMd).isSymbolicLink()) {
      const result = loadSkillFromFile(skillMd, source);
      diagnostics.push(...result.diagnostics);
      if (result.skill) skills.push(result.skill);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      visit(join(current, entry.name), depth + 1);
    }
  };

  visit(root, 0);
  return { skills, diagnostics };
}

function projectSkillRoots(projectDirectory: string): string[] {
  const project = resolve(projectDirectory);
  const chain: string[] = [];
  let current = project;

  while (true) {
    chain.push(current);
    if (existsSync(join(current, ".git"))) {
      // Project-near first so nested package skills override monorepo skills.
      return chain.map((dir) => join(dir, AGENTS_SKILLS));
    }
    const parent = dirname(current);
    if (parent === current) {
      // Outside a git repo, only the Project directory itself is scanned.
      return [join(project, AGENTS_SKILLS)];
    }
    current = parent;
  }
}

export interface DiscoverSkillsOptions {
  projectDirectory: string;
  /** Defaults to the user home directory. Overridable for tests. */
  homeDirectory?: string;
}

/**
 * Load skills from global and project `.agents/skills` only.
 * Precedence (first wins): project roots near→far, then host-global.
 */
export function discoverSkills(options: DiscoverSkillsOptions): LoadSkillsResult {
  const home = resolve(options.homeDirectory ?? homedir());
  const skillMap = new Map<string, Skill>();
  const realPathSet = new Set<string>();
  const diagnostics: SkillDiagnostic[] = [];

  const add = (result: LoadSkillsResult) => {
    diagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      const realPath = canonicalize(skill.filePath);
      if (realPathSet.has(realPath)) continue;

      const existing = skillMap.get(skill.name);
      if (existing) {
        diagnostics.push({
          type: "collision",
          message: `name "${skill.name}" collision`,
          path: skill.filePath,
          name: skill.name,
          winnerPath: existing.filePath,
          loserPath: skill.filePath,
        });
        continue;
      }

      skillMap.set(skill.name, skill);
      realPathSet.add(realPath);
    }
  };

  for (const root of projectSkillRoots(options.projectDirectory)) {
    add(loadSkillsFromDir(root, "project"));
  }
  add(loadSkillsFromDir(join(home, AGENTS_SKILLS), "host"));

  return {
    skills: [...skillMap.values()],
    diagnostics,
  };
}
