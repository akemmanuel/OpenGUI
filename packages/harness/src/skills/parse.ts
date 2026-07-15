/**
 * Minimal YAML frontmatter parser for Agent Skills SKILL.md files.
 * Supports the fields OpenGUI needs without a full YAML dependency.
 */

export interface ParsedSkillDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

function stripQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  return stripQuotes(value);
}

/** Parse simple YAML mapping frontmatter (string/boolean values, optional block scalars). */
export function parseFrontmatter(content: string): ParsedSkillDocument {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: normalized };
  }

  const afterOpen = normalized.slice(3).replace(/^\r?\n/, "");
  const closeMatch = afterOpen.match(/\r?\n---[ \t]*\r?\n/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: {}, body: normalized };
  }

  const yamlBlock = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  const frontmatter: Record<string, unknown> = {};

  const lines = yamlBlock.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      index += 1;
      continue;
    }

    const key = match[1] ?? "";
    const rest = match[2] ?? "";
    if (rest === "|" || rest === ">") {
      const blockLines: string[] = [];
      index += 1;
      while (index < lines.length) {
        const blockLine = lines[index] ?? "";
        if (blockLine.length > 0 && !/^[ \t]/.test(blockLine) && !/^\s*$/.test(blockLine)) break;
        blockLines.push(blockLine.replace(/^[ \t]/, ""));
        index += 1;
      }
      frontmatter[key] = blockLines.join("\n").replace(/\n+$/, "");
      continue;
    }

    frontmatter[key] = parseScalar(rest);
    index += 1;
  }

  return { frontmatter, body };
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateSkillName(name: string): string[] {
  const errors: string[] = [];
  if (name.length < 1 || name.length > 64) {
    errors.push("name must be 1-64 characters");
  }
  if (!NAME_PATTERN.test(name)) {
    errors.push(
      "name must be lowercase letters, numbers, and single hyphens (no leading/trailing/consecutive hyphens)",
    );
  }
  return errors;
}

export function validateDescription(description: unknown): string[] {
  if (typeof description !== "string" || description.trim() === "") {
    return ["description is required"];
  }
  if (description.length > 1024) {
    return ["description exceeds 1024 characters"];
  }
  return [];
}
