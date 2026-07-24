import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type PathGrantAccess = "read" | "write";

export type CanonicalPathGrant = {
  root: string;
  access: PathGrantAccess;
};

export type PathPolicyDecision = {
  allowed: boolean;
  canonicalPath?: string;
  reason?: "outside_allowed_roots" | "outside_grants" | "symlink_traversal" | "not_found";
};

export type EffectivePathPolicy = {
  revision: number;
  restricted: boolean;
  shellAllowed: boolean;
  grants: CanonicalPathGrant[];
  authorizePath(
    path: string,
    access: PathGrantAccess,
    options?: { allowMissingLeaf?: boolean },
  ): Promise<PathPolicyDecision>;
  canAccessProject(path: string): Promise<boolean>;
};

export function containsPath(root: string, candidate: string) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

async function canonicalExistingDirectory(path: string) {
  const canonical = await realpath(resolve(path));
  if (!(await stat(canonical)).isDirectory()) throw new Error("Path is not a directory");
  return canonical;
}

export async function canonicalizeAllowedRoots(roots: string[]) {
  const canonical = await Promise.all(roots.map((root) => canonicalExistingDirectory(root)));
  return [...new Set(canonical)];
}

export async function canonicalizeGrantRoot(path: string, allowedRoots: string[]) {
  const [canonical, roots] = await Promise.all([
    canonicalExistingDirectory(path),
    canonicalizeAllowedRoots(allowedRoots),
  ]);
  if (!roots.some((root) => containsPath(root, canonical))) {
    throw new Error("Grant root is outside OPENGUI_ALLOWED_ROOTS");
  }
  return canonical;
}

async function inspectPathWithoutSymlinks(
  requestedPath: string,
  allowedBoundary: string,
  grantBoundary: string,
  allowMissingLeaf: boolean,
): Promise<PathPolicyDecision> {
  const absolute = resolve(requestedPath);
  if (!containsPath(allowedBoundary, grantBoundary) || !containsPath(grantBoundary, absolute)) {
    return { allowed: false, reason: "outside_grants" };
  }

  try {
    const boundaryInfo = await lstat(allowedBoundary);
    if (boundaryInfo.isSymbolicLink()) {
      return { allowed: false, reason: "symlink_traversal" };
    }
    if (!boundaryInfo.isDirectory() || (await realpath(allowedBoundary)) !== allowedBoundary) {
      return { allowed: false, reason: "not_found" };
    }
  } catch {
    return { allowed: false, reason: "not_found" };
  }

  const fromBoundary = relative(allowedBoundary, absolute);
  const parts = fromBoundary === "" ? [] : fromBoundary.split(sep);
  const grantPartCount = relative(allowedBoundary, grantBoundary).split(sep).filter(Boolean).length;
  let current = allowedBoundary;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        return { allowed: false, reason: "symlink_traversal" };
      }
      if (index + 1 === grantPartCount && !info.isDirectory()) {
        return { allowed: false, reason: "not_found" };
      }
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      const missingBelowGrant = index + 1 > grantPartCount;
      if (!missing || !allowMissingLeaf || !missingBelowGrant) {
        return { allowed: false, reason: "not_found" };
      }
      // A missing suffix is safe for a future write after every existing ancestor was checked.
      break;
    }
  }
  return { allowed: true, canonicalPath: absolute };
}

export function createEffectivePathPolicy(input: {
  revision: number;
  restricted: boolean;
  allowedRoots: string[];
  grants: CanonicalPathGrant[];
}): EffectivePathPolicy {
  const grants = input.grants.map((grant) => ({ ...grant }));

  async function authorizePath(
    path: string,
    access: PathGrantAccess,
    options: { allowMissingLeaf?: boolean } = {},
  ): Promise<PathPolicyDecision> {
    const absolute = resolve(path);
    const inAllowedRoot = input.allowedRoots.some((root) => containsPath(root, absolute));
    if (!inAllowedRoot) return { allowed: false, reason: "outside_allowed_roots" };
    if (!input.restricted) {
      try {
        const canonical = await realpath(absolute);
        return input.allowedRoots.some((root) => containsPath(root, canonical))
          ? { allowed: true, canonicalPath: canonical }
          : { allowed: false, reason: "outside_allowed_roots" };
      } catch (error) {
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
        if (!missing || access !== "write" || options.allowMissingLeaf !== true) {
          return { allowed: false, reason: "not_found" };
        }
        let ancestor = dirname(absolute);
        while (true) {
          try {
            const canonicalAncestor = await realpath(ancestor);
            const suffix = relative(ancestor, absolute);
            const canonical = resolve(canonicalAncestor, suffix);
            return input.allowedRoots.some((root) => containsPath(root, canonical))
              ? { allowed: true, canonicalPath: canonical }
              : { allowed: false, reason: "outside_allowed_roots" };
          } catch (ancestorError) {
            const ancestorMissing =
              ancestorError instanceof Error &&
              "code" in ancestorError &&
              ancestorError.code === "ENOENT";
            const parent = dirname(ancestor);
            if (!ancestorMissing || parent === ancestor) {
              return { allowed: false, reason: "not_found" };
            }
            ancestor = parent;
          }
        }
      }
    }

    const grant = grants.find(
      (candidate) =>
        containsPath(candidate.root, absolute) &&
        (access === "read" || candidate.access === "write"),
    );
    if (!grant) return { allowed: false, reason: "outside_grants" };
    const allowedRoot = input.allowedRoots.find((root) => containsPath(root, grant.root));
    if (!allowedRoot) return { allowed: false, reason: "outside_allowed_roots" };
    return await inspectPathWithoutSymlinks(
      absolute,
      allowedRoot,
      grant.root,
      access === "write" && options.allowMissingLeaf === true,
    );
  }

  return {
    revision: input.revision,
    restricted: input.restricted,
    shellAllowed: !input.restricted,
    grants,
    authorizePath,
    async canAccessProject(path: string) {
      return (await authorizePath(path, "read")).allowed;
    },
  };
}
