import { readdir, readFile, rename, unlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

export interface SessionInfo { sessionId: string; summary?: string; firstPrompt?: string; customTitle?: string; lastModified?: number; createdAt?: number; cwd?: string; model?: string }

function projectDir(dir?: string): string {
  const cwd = dir ?? process.cwd();
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", slug);
}
function sessionFile(sessionId: string, dir?: string): string { return join(projectDir(dir), `${sessionId}.jsonl`); }

export async function listSessions(opts: { dir?: string; limit?: number } = {}): Promise<SessionInfo[]> {
  try {
    const files = (await readdir(projectDir(opts.dir), { withFileTypes: true })).filter((f) => f.isFile() && f.name.endsWith(".jsonl"));
    const infos = await Promise.all(files.map((f) => getSessionInfo(f.name.slice(0, -6), { dir: opts.dir })));
    return infos.filter(Boolean).sort((a, b) => (b!.lastModified ?? 0) - (a!.lastModified ?? 0)).slice(0, opts.limit ?? Infinity) as SessionInfo[];
  } catch { return []; }
}

export async function getSessionMessages(sessionId: string, opts: { dir?: string; includeSystemMessages?: boolean } = {}): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(sessionFile(sessionId, opts.dir), "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((m) => opts.includeSystemMessages !== false || m.type !== "system");
  } catch { return []; }
}

export async function getSessionInfo(sessionId: string, opts: { dir?: string } = {}): Promise<SessionInfo | null> {
  const messages = await getSessionMessages(sessionId, { dir: opts.dir, includeSystemMessages: true });
  if (!messages.length) return null;
  const first = messages[0] as any, last = messages[messages.length - 1] as any;
  const firstUser = messages.find((m: any) => m.type === "user") as any;
  const firstPrompt = contentText(firstUser?.message?.content);
  return { sessionId, summary: first?.summary ?? firstPrompt?.slice(0, 80), firstPrompt, customTitle: first?.customTitle, cwd: first?.cwd ?? opts.dir, model: last?.message?.model ?? first?.model, createdAt: timestamp(first) ?? Date.now(), lastModified: timestamp(last) ?? Date.now() };
}

export async function renameSession(sessionId: string, title: string, opts: { dir?: string } = {}): Promise<void> {
  const file = sessionFile(sessionId, opts.dir); const lines = (await readFile(file, "utf8")).split(/\r?\n/); const first = lines.findIndex(Boolean);
  if (first >= 0) { const obj = JSON.parse(lines[first]!); obj.customTitle = title; obj.summary = title; lines[first] = JSON.stringify(obj); await writeFile(file, lines.join("\n")); }
}

export async function deleteSession(sessionId: string, opts: { dir?: string } = {}): Promise<void> { await unlink(sessionFile(sessionId, opts.dir)).catch(() => {}); }

export async function forkSession(sessionId: string, opts: { dir?: string; upToMessageId?: string } = {}): Promise<{ sessionId: string }> {
  const messages = await getSessionMessages(sessionId, { dir: opts.dir, includeSystemMessages: true });
  const idx = opts.upToMessageId ? messages.findIndex((m: any) => m.uuid === opts.upToMessageId || m.message?.id === opts.upToMessageId) : -1;
  const kept = idx >= 0 ? messages.slice(0, idx + 1) : messages;
  const newId = randomUUID(); await mkdir(projectDir(opts.dir), { recursive: true });
  await writeFile(sessionFile(newId, opts.dir), kept.map((m) => JSON.stringify({ ...m, session_id: newId })).join("\n") + "\n");
  return { sessionId: newId };
}

function timestamp(m: any): number | undefined { const t = m?.timestamp ?? m?.created_at ?? m?.time; const n = typeof t === "string" ? Date.parse(t) : typeof t === "number" ? t : NaN; return Number.isFinite(n) ? n : undefined; }
function contentText(c: unknown): string { if (typeof c === "string") return c; if (Array.isArray(c)) return c.map((x: any) => x?.text ?? "").join(""); return ""; }
export function projectHash(dir: string): string { return createHash("sha1").update(dir).digest("hex"); }

