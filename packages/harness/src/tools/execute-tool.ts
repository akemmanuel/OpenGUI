import { isAbsolute, resolve } from "node:path";
import type { ExecutionPolicy } from "../execution-policy.ts";
import { executeEditTool } from "./edit.ts";
import { executeReadTool } from "./read.ts";
import { executeShellTool, type ShellToolContext } from "./shell.ts";
import { executeWriteTool } from "./write.ts";

export interface ToolExecutionContext extends ShellToolContext {
  executionPolicy: ExecutionPolicy;
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
  if (
    name === "shell" &&
    (context.executionPolicy.restricted || !context.executionPolicy.shellAllowed)
  ) {
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

  switch (name) {
    case "read":
      return executeReadTool(context.projectDirectory, input, authorizedPath);
    case "write":
      return executeWriteTool(context.projectDirectory, input, authorizedPath);
    case "edit":
      return executeEditTool(context.projectDirectory, input, authorizedPath);
    case "shell":
      return executeShellTool(context, input);
    default:
      return Promise.resolve({ error: `Unknown tool: ${name}` });
  }
}
