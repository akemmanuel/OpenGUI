import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExecutionPolicy } from "../execution-policy.ts";
import { executeEditTool } from "./edit.ts";
import { executeReadTool } from "./read.ts";
import { executeShellTool, type ShellToolContext } from "./shell.ts";
import { executeWriteTool } from "./write.ts";

export interface ToolExecutionContext extends ShellToolContext {
  executionPolicy: ExecutionPolicy;
  shellExecutor?: ShellToolExecutor;
}

export type ShellToolExecutor = (context: ToolExecutionContext, input: unknown) => Promise<unknown>;

const MAX_TOOL_RESULT_BYTES = 5 * 1024;

function safePathSegment(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
}

function utf8Head(value: string, maximumBytes: number) {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.byteLength, maximumBytes);
  while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function utf8Tail(value: string, maximumBytes: number) {
  const bytes = Buffer.from(value);
  let start = Math.max(0, bytes.byteLength - maximumBytes);
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function hasImageAttachments(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const attachments = (result as Record<string, unknown>).attachments;
  return (
    Array.isArray(attachments) &&
    attachments.some(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        (item as Record<string, unknown>).type === "image",
    )
  );
}

function imageExtension(mimeType: string) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/bmp") return ".bmp";
  return ".png";
}

async function externalizeImageAttachments(context: ToolExecutionContext, result: unknown) {
  if (!hasImageAttachments(result) || !result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  const outputDirectory = join(
    context.dataDirectory,
    "tool-output",
    safePathSegment(context.sessionId),
  );
  await mkdir(outputDirectory, { recursive: true });
  const attachments = await Promise.all(
    (record.attachments as unknown[]).map(async (attachment, index) => {
      if (!attachment || typeof attachment !== "object") return attachment;
      const image = attachment as Record<string, unknown>;
      if (
        image.type !== "image" ||
        typeof image.data !== "string" ||
        typeof image.mimeType !== "string"
      )
        return attachment;
      const path = join(
        outputDirectory,
        `${safePathSegment(context.toolCallId)}-${index}${imageExtension(image.mimeType)}`,
      );
      await writeFile(path, Buffer.from(image.data, "base64"));
      const { data: _data, ...reference } = image;
      return { ...reference, path };
    }),
  );
  return { ...record, attachments };
}

export async function limitToolResult(context: ToolExecutionContext, result: unknown) {
  const durableResult = await externalizeImageAttachments(context, result);
  const serialized = JSON.stringify(durableResult);
  if (Buffer.byteLength(serialized) <= MAX_TOOL_RESULT_BYTES) return durableResult;

  const outputDirectory = join(tmpdir(), "opengui-tool-output", safePathSegment(context.sessionId));
  await mkdir(outputDirectory, { recursive: true });
  const fullOutputPath = join(outputDirectory, `${safePathSegment(context.toolCallId)}.json`);
  await writeFile(fullOutputPath, serialized, "utf8");

  const separator = "\n\n… tool result truncated …\n\n";
  const notice = `\n\nThe full tool result has been saved to ${fullOutputPath}.`;
  const availableBytes =
    MAX_TOOL_RESULT_BYTES - Buffer.byteLength(separator) - Buffer.byteLength(notice) - 512;
  const headBytes = Math.ceil(availableBytes / 2);
  const tailBytes = Math.floor(availableBytes / 2);
  return {
    output: `${utf8Head(serialized, headBytes)}${separator}${utf8Tail(serialized, tailBytes)}${notice}`,
    truncated: true,
    fullOutputPath,
  };
}

function requestedPath(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const path = (input as Record<string, unknown>).path;
  return typeof path === "string" && path.trim() ? path : null;
}

function denied(context: ToolExecutionContext, name: string, reason?: string) {
  return {
    denied: true,
    error: `Execution policy denied ${name}`,
    policyRevision: context.executionPolicy.revision,
    ...(reason ? { reason } : {}),
  };
}

export async function executeTool(context: ToolExecutionContext, name: string, input: unknown) {
  if (name === "shell" && !context.executionPolicy.shellAllowed) {
    return denied(context, name, "shell_not_allowed");
  }

  let authorizedPath: string | undefined;
  if (name === "read" || name === "write" || name === "edit") {
    const path = requestedPath(input);
    if (path) {
      const access = name === "read" ? "read" : "write";
      const targetPath = isAbsolute(path) ? resolve(path) : resolve(context.projectDirectory, path);
      const decision = await context.executionPolicy.authorizePath(targetPath, access, {
        allowMissingLeaf: name === "write",
      });
      if (!decision.allowed || !decision.canonicalPath) {
        return denied(context, name, decision.reason ?? "path_not_allowed");
      }
      authorizedPath = decision.canonicalPath;
    }
  }

  let result: unknown;
  switch (name) {
    case "read":
      result = await executeReadTool(context.projectDirectory, input, authorizedPath);
      break;
    case "write":
      result = await executeWriteTool(context.projectDirectory, input, authorizedPath);
      break;
    case "edit":
      result = await executeEditTool(context.projectDirectory, input, authorizedPath);
      break;
    case "shell":
      result = context.executionPolicy.restricted
        ? await context.shellExecutor?.(context, input)
        : await executeShellTool(context, input);
      if (result === undefined) result = denied(context, name, "sandbox_not_configured");
      break;
    default:
      result = { error: `Unknown tool: ${name}` };
  }
  return limitToolResult(context, result);
}
