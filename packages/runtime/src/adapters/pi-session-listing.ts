// @ts-nocheck
import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function getPiSessionDir(cwd, agentDir = getAgentDir()) {
  const safePath = `--${cwd.replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
}

function extractPiListTextContent(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

async function buildFastPiSessionInfo(filePath, stats) {
  try {
    const maxBytes = Math.min(stats.size, 64 * 1024);
    const handle = await open(filePath, "r");
    let content;
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

    let header = null;
    let messageCount = 0;
    let firstMessage = "";
    let name;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (!header) {
        if (entry.type !== "session" || typeof entry.id !== "string") return null;
        header = entry;
        continue;
      }

      if (entry.type === "session_info") {
        name = entry.name?.trim() || undefined;
        continue;
      }

      if (entry.type !== "message") continue;
      messageCount++;
      const message = entry.message;
      if (!message || (message.role !== "user" && message.role !== "assistant")) continue;

      if (!firstMessage && message.role === "user") {
        firstMessage = extractPiListTextContent(message);
        if (name) break;
      }
    }

    if (!header) return null;
    const headerTime = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    const created = !Number.isNaN(headerTime) ? new Date(headerTime) : stats.birthtime;

    return {
      path: filePath,
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name,
      parentSessionPath: header.parentSession,
      created,
      modified: stats.mtime,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
    };
  } catch {
    return null;
  }
}

async function mapPiSessionInfoWithConcurrency(items, limit, mapper) {
  const results = Array.from({ length: items.length });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function invalidatePiSessionListCacheForDirectory(
  directory,
  agentDir,
  cache,
  directoryCache,
) {
  const sessionDir = getPiSessionDir(directory, agentDir);
  directoryCache.delete(sessionDir);
  for (const filePath of cache.keys()) {
    if (filePath.startsWith(`${sessionDir}/`)) cache.delete(filePath);
  }
}

export async function listFastPiSessionInfos(directory, agentDir, cache, directoryCache) {
  const sessionDir = getPiSessionDir(directory, agentDir);
  if (!existsSync(sessionDir)) return [];
  let entries;
  try {
    entries = await readdir(sessionDir);
  } catch {
    return [];
  }

  const files = entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => join(sessionDir, entry));
  const fileStats = await Promise.all(
    files.map(async (filePath) => {
      try {
        return { filePath, stats: await stat(filePath) };
      } catch {
        cache.delete(filePath);
        return null;
      }
    }),
  );
  const liveStats = fileStats.filter(Boolean);
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
    .filter(Boolean)
    .sort((a, b) => (b.modified?.getTime?.() ?? 0) - (a.modified?.getTime?.() ?? 0));
  directoryCache.set(sessionDir, { signature, infos: sortedInfos });
  return sortedInfos;
}
