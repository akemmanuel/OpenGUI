import type { PathGrant, PathPolicyStatus } from "./identity-client";

export function pathGrantAdministrationEnabled(status: PathPolicyStatus | null | undefined) {
  return status?.mode === "enforced" && status.enforcementReady === true;
}

export function appendPathGrant(grants: PathGrant[], root: string): PathGrant[] {
  const trimmed = root.trim();
  if (!trimmed) return grants;
  const existing = grants.findIndex((grant) => grant.root === trimmed);
  if (existing < 0) return [...grants, { root: trimmed, access: "read" }];
  return grants;
}

export function replaceGrantAccess(
  grants: PathGrant[],
  index: number,
  access: PathGrant["access"],
) {
  return grants.map((grant, current) => (current === index ? { ...grant, access } : grant));
}

export function removePathGrant(grants: PathGrant[], index: number) {
  return grants.filter((_, current) => current !== index);
}
