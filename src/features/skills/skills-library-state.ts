import type { HostSkillInstallation, HostSkillScope } from "@/protocol/host-types";

export type SkillManagementAccess = {
  canManageHost: boolean;
  canManageProject: boolean;
  projectWriteAccess: "allowed" | "denied" | "unknown";
};

export function skillManagementAccess(
  actor: { type: string; role?: string } | null,
  projectWriteAccess: SkillManagementAccess["projectWriteAccess"],
): SkillManagementAccess {
  const administrator =
    actor?.type === "local" ||
    (actor?.type === "user" && (actor.role === "owner" || actor.role === "admin"));
  return {
    canManageHost: administrator,
    canManageProject: administrator && projectWriteAccess !== "denied",
    projectWriteAccess,
  };
}

export function isSupportedSkillSource(value: string) {
  const source = value.trim();
  if (
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,38})\/[A-Za-z0-9_.-]{1,100}@[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(
      source,
    )
  )
    return true;
  const match =
    /^github:([A-Za-z0-9](?:[A-Za-z0-9.-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/(.+)@([^@]+)$/u.exec(
      source,
    );
  if (!match) return false;
  const path = match[3]!;
  const revision = match[4]!;
  return (
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((part) => part && part !== "." && part !== "..") &&
    /^[A-Za-z0-9._/-]{1,200}$/u.test(revision) &&
    !revision.includes("..")
  );
}

export function filterSkillInstallations(
  skills: readonly HostSkillInstallation[],
  query: string,
  scope: HostSkillScope | "all",
) {
  const needle = query.trim().toLocaleLowerCase();
  return skills.filter((skill) => {
    if (scope !== "all" && skill.scope !== scope) return false;
    if (!needle) return true;
    return [skill.name, skill.description, skill.source, skill.resolvedSource, skill.revision]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(needle));
  });
}

export function pathHasWriteGrant(
  directory: string,
  grants: readonly { root: string; access: "read" | "write" }[],
) {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const target = normalize(directory);
  return grants.some((grant) => {
    const root = normalize(grant.root);
    return grant.access === "write" && (target === root || target.startsWith(`${root}/`));
  });
}
