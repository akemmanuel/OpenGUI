import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type PiFastSessionInfo = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
};

export function getPiSessionDir(cwd: string, agentDir: string = getAgentDir()) {
  const safePath = `--${cwd.replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
}

function extractPiListTextContent(message: { content?: unknown }) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } =>
      Boolean(block && typeof block === "object" && (block as { type?: string }).type === "text"),
    )
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join(" ");
}

type PiSessionFileStatRow = {
  filePath: string;
  stats: { size: number; birthtime: Date; mtime: Date; mtimeMs: number };
};

async function buildFastPiSessionInfo(
  filePath: string,
  stats: PiSessionFileStatRow["stats"],
): Promise<PiFastSessionInfo | null> {
  try {
    const maxBytes = Math.min(stats.size, 64 * 1024);
    const handle = await open(filePath, "r");
    let content: string;
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      content = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }

    const lastNewline = content.lastIndexOf("\n");
    if (lastNewline >= 0 && lastNewline < content.length - 1 && maxBytes < stats.size) {
      content = content.slice(0, lastNewline + 1);
    }

    let header: {
      type?: string;
      id?: string;
      timestamp?: string;
      cwd?: string;
      parentSession?: string;
    } | null = null;
    let messageCount = 0;
    let firstMessage = "";
    let name: string | undefined;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (!header) {
        if (entry.type !== "session" || typeof entry.id !== "string") return null;
        header = entry;
        continue;
      }

      if (entry.type === "session_info") {
        const n = entry.name;
        name = typeof n === "string" ? n.trim() || undefined : undefined;
        continue;
      }

      if (entry.type !== "message") continue;
      messageCount++;
      const message = entry.message as { role?: string; content?: unknown } | undefined;
      if (!message || (message.role !== "user" && message.role !== "assistant")) continue;

      if (!firstMessage && message.role === "user") {
        firstMessage = extractPiListTextContent(message);
        if (name) break;
      }
    }

    if (!header || typeof header.id !== "string") return null;
    const headerTime = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    const created = !Number.isNaN(headerTime) ? new Date(headerTime) : stats.birthtime;

    return {
      path: filePath,
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name,
      parentSessionPath:
        typeof header.parentSession === "string" ? header.parentSession : undefined,
      created,
      modified: stats.mtime,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
    };
  } catch {
    return null;
  }
}

async function mapPiSessionInfoWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function invalidatePiSessionListCacheForDirectory(
  directory: string,
  agentDir: string,
  cache: Map<string, { size: number; mtimeMs: number; info: PiFastSessionInfo }>,
  directoryCache: Map<string, { signature: string; infos: PiFastSessionInfo[] }>,
) {
  const sessionDir = getPiSessionDir(directory, agentDir);
  directoryCache.delete(sessionDir);
  for (const filePath of cache.keys()) {
    if (filePath.startsWith(`${sessionDir}/`)) cache.delete(filePath);
  }
}

export async function listFastPiSessionInfos(
  directory: string,
  agentDir: string,
  cache: Map<string, { size: number; mtimeMs: number; info: PiFastSessionInfo }>,
  directoryCache: Map<string, { signature: string; infos: PiFastSessionInfo[] }>,
): Promise<PiFastSessionInfo[]> {
  const sessionDir = getPiSessionDir(directory, agentDir);
  if (!existsSync(sessionDir)) return [];
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch {
    return [];
  }

  const files = entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => join(sessionDir, entry));
  const fileStats: Array<PiSessionFileStatRow | null> = await Promise.all(
    files.map(async (filePath): Promise<PiSessionFileStatRow | null> => {
      try {
        const st = await stat(filePath);
        return {
          filePath,
          stats: {
            size: Number(st.size),
            birthtime: st.birthtime,
            mtime: st.mtime,
            mtimeMs: Number(st.mtimeMs),
          },
        };
      } catch {
        cache.delete(filePath);
        return null;
      }
    }),
  );
  const liveStats = fileStats.filter((row): row is PiSessionFileStatRow => row !== null);
  const signature = liveStats
    .map(({ filePath, stats }) => `${filePath}:${stats.size}:${stats.mtimeMs}`)
    .join("\n");
  const cachedDirectory = directoryCache.get(sessionDir);
  if (cachedDirectory?.signature === signature) return cachedDirectory.infos;

  const infos = await mapPiSessionInfoWithConcurrency(liveStats, 4, async ({ filePath, stats }) => {
    const cached = cache.get(filePath);
    if (cached && cached.size === stats.size && Math.abs(cached.mtimeMs - stats.mtimeMs) < 1000) {
      return cached.info;
    }
    const info = await buildFastPiSessionInfo(filePath, stats);
    if (info) cache.set(filePath, { size: stats.size, mtimeMs: stats.mtimeMs, info });
    else cache.delete(filePath);
    return info;
  });
  const liveFiles = new Set(files);
  for (const filePath of cache.keys()) {
    if (filePath.startsWith(`${sessionDir}/`) && !liveFiles.has(filePath)) cache.delete(filePath);
  }
  const sortedInfos = infos
    .filter((info): info is PiFastSessionInfo => info !== null)
    .sort((a, b) => (b.modified?.getTime?.() ?? 0) - (a.modified?.getTime?.() ?? 0));
  directoryCache.set(sessionDir, { signature, infos: sortedInfos });
  return sortedInfos;
}
