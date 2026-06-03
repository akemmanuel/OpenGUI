import { basename } from "node:path";
import type { CreateProjectInput, UpdateProjectInput } from "./index.ts";
import { toOptionalNullableString, toOptionalString } from "./http-input.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseCreateProjectInput(body: unknown): CreateProjectInput {
  if (!isPlainObject(body)) throw new Error("Request body must be an object");
  if (typeof body.path !== "string" || !body.path.trim()) {
    throw new Error("Project path is required");
  }
  if (body.git !== undefined && !isPlainObject(body.git)) {
    throw new Error("Project git must be an object");
  }

  return {
    path: body.path,
    canonicalPath: toOptionalString(body.canonicalPath, "canonicalPath"),
    displayName:
      toOptionalString(body.displayName, "displayName") ??
      basename(body.path.replace(/[\\/]+$/, "")) ??
      "Project",
    allowedRootId: toOptionalString(body.allowedRootId, "allowedRootId"),
    git: body.git as CreateProjectInput["git"],
  };
}

export function parseUpdateProjectInput(body: unknown): UpdateProjectInput {
  if (!isPlainObject(body)) throw new Error("Request body must be an object");
  if (body.git !== undefined && !isPlainObject(body.git)) {
    throw new Error("Project git must be an object");
  }

  return {
    displayName: toOptionalString(body.displayName, "displayName"),
    path: toOptionalString(body.path, "path"),
    canonicalPath: toOptionalString(body.canonicalPath, "canonicalPath"),
    allowedRootId: toOptionalNullableString(body.allowedRootId, "allowedRootId"),
    git: body.git as UpdateProjectInput["git"],
  };
}

export async function normalizeCreateProjectInput(
  input: CreateProjectInput,
  resolveSafeDirectory: (path: string) => Promise<string>,
  realpath: (path: string) => Promise<string>,
): Promise<CreateProjectInput> {
  const path = await resolveSafeDirectory(input.path);
  const canonicalPath = input.canonicalPath
    ? await resolveSafeDirectory(input.canonicalPath)
    : await realpath(path);
  return {
    ...input,
    path,
    canonicalPath,
    displayName:
      input.displayName?.trim() || basename(canonicalPath) || basename(path) || "Project",
  };
}

export async function normalizeUpdateProjectInput(
  input: UpdateProjectInput,
  resolveSafeDirectory: (path: string) => Promise<string>,
  realpath: (path: string) => Promise<string>,
): Promise<UpdateProjectInput> {
  const path = input.path ? await resolveSafeDirectory(input.path) : undefined;
  const canonicalPath = input.canonicalPath
    ? await resolveSafeDirectory(input.canonicalPath)
    : path
      ? await realpath(path)
      : undefined;
  return {
    ...input,
    path,
    canonicalPath,
    displayName: input.displayName?.trim() || undefined,
  };
}
