/**
 * Turns whatever a person pastes from an MCP server's setup guide (an endpoint
 * URL or a launch command) into a connection draft with a sensible name and id.
 */

export type EnvironmentRow = { key: string; value: string };

export type ParsedMcpInput =
  | { kind: "http"; url: string; label: string }
  | { kind: "stdio"; commandLine: string; env: EnvironmentRow[]; label: string };

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su;
const RUNNER_SUBCOMMANDS = new Set(["dlx", "exec", "run", "x"]);
const RUNNERS = new Set(["npx", "bunx", "pnpx", "pnpm", "yarn", "uvx", "uv", "pipx", "deno"]);

/** Split a command line into arguments, honouring single quotes, double quotes and backslashes. */
export function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < line.length) {
        index += 1;
        current += line[index];
      } else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < line.length) {
      index += 1;
      current += line[index];
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

function quoteToken(token: string) {
  if (token === "") return "''";
  if (!/[\s"'\\]/u.test(token)) return token;
  return `'${token.replace(/'/gu, `'"'"'`)}'`;
}

/** Inverse of {@link tokenizeCommandLine} for a saved command and its arguments. */
export function formatCommandLine(command: string, args: readonly string[]) {
  return [command, ...args].map(quoteToken).join(" ");
}

function titleCase(value: string) {
  return value
    .split(/[-_\s.]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
    .join(" ");
}

function cleanPackageName(raw: string) {
  let name = raw.replace(/^(@[^/]+\/)?/u, "").replace(/@[^@/]*$/u, "");
  name =
    name
      .split(/[/\\:]/u)
      .filter(Boolean)
      .pop() ?? name;
  name = name.replace(/\.(m?js|cjs|ts|py)$/u, "");
  name = name
    .replace(/^(mcp[-_]server[-_]|server[-_]|mcp[-_])/iu, "")
    .replace(/([-_]mcp[-_]server|[-_]mcp|[-_]server)$/iu, "");
  return titleCase(name);
}

/** A readable name for a server started by `command args`. */
export function labelFromCommand(tokens: readonly string[]) {
  const [command, ...args] = tokens;
  if (!command) return "";
  const executable = command.split(/[/\\]/u).pop() ?? command;
  const operands = args.filter((arg) => !arg.startsWith("-"));
  if (executable === "docker" || executable === "podman") {
    return cleanPackageName(args.at(-1) ?? executable);
  }
  if (RUNNERS.has(executable)) {
    const target = operands.find((arg) => !RUNNER_SUBCOMMANDS.has(arg));
    return cleanPackageName(target ?? executable);
  }
  if (/^(node|python3?|bun|deno|tsx)$/u.test(executable) && operands[0]) {
    return cleanPackageName(operands[0]);
  }
  return cleanPackageName(executable);
}

/** A readable name for a remote server, e.g. `https://mcp.notion.com/mcp` → "Notion". */
export function labelFromUrl(value: string) {
  try {
    const url = new URL(value);
    const parts = url.hostname.split(".").filter(Boolean);
    const meaningful = parts.filter(
      (part, index) => index < parts.length - 1 && !/^(mcp|www|api|app|server)$/iu.test(part),
    );
    return titleCase(meaningful[0] ?? parts[0] ?? url.hostname);
  } catch {
    return "";
  }
}

/** Connection ids accept 1-64 letters, digits, dots, dashes and underscores. */
export function connectionIdFrom(label: string, taken: Iterable<string> = []) {
  const base =
    label
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 56) || "server";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Interpret pasted text as a remote endpoint or a local launch command. */
export function parseMcpInput(text: string): ParsedMcpInput | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//iu.test(trimmed)) {
    if (/\s/u.test(trimmed)) return null;
    return { kind: "http", url: trimmed, label: labelFromUrl(trimmed) };
  }
  const tokens = tokenizeCommandLine(trimmed);
  const env: EnvironmentRow[] = [];
  while (tokens.length > 1) {
    const match = ENV_ASSIGNMENT.exec(tokens[0] as string);
    if (!match) break;
    env.push({ key: match[1] as string, value: match[2] as string });
    tokens.shift();
  }
  if (tokens.length === 0) return null;
  return {
    kind: "stdio",
    commandLine: formatCommandLine(tokens[0] as string, tokens.slice(1)),
    env,
    label: labelFromCommand(tokens),
  };
}
