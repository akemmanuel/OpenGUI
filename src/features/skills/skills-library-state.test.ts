import { describe, expect, test } from "vite-plus/test";
import type { HostSkillInstallation } from "@/protocol/host-types";
import {
  filterSkillInstallations,
  isSupportedSkillSource,
  pathHasWriteGrant,
  skillManagementAccess,
} from "./skills-library-state";

const skill: HostSkillInstallation = {
  name: "review",
  description: "Review changes",
  manual: false,
  scope: "project",
  location: "/project/.agents/skills/review",
  managed: true,
  modified: false,
  generation: 4,
  source: "github:acme/skills/review@main",
  revision: "abc123",
};

describe("Skills library state", () => {
  test("accepts only the Host's explicit and legacy GitHub source grammars", () => {
    expect(isSupportedSkillSource("github:acme/skills/review@main")).toBe(true);
    expect(isSupportedSkillSource("acme/skills@review")).toBe(true);
    expect(isSupportedSkillSource("https://example.com/skill")).toBe(false);
    expect(isSupportedSkillSource("github:acme/skills/../review@main")).toBe(false);
  });

  test("searches metadata and combines search with scope", () => {
    const hostSkill = { ...skill, name: "deploy", scope: "host" as const, revision: "def456" };
    expect(filterSkillInstallations([skill, hostSkill], "abc", "project")).toEqual([skill]);
    expect(filterSkillInstallations([skill, hostSkill], "deploy", "project")).toEqual([]);
  });

  test("keeps management role and project write access separate", () => {
    expect(skillManagementAccess({ type: "user", role: "viewer" }, "allowed")).toEqual({
      canManageHost: false,
      canManageProject: false,
      projectWriteAccess: "allowed",
    });
    expect(skillManagementAccess({ type: "user", role: "admin" }, "denied")).toMatchObject({
      canManageHost: true,
      canManageProject: false,
    });
    expect(
      pathHasWriteGrant("/srv/project/nested", [{ root: "/srv/project", access: "write" }]),
    ).toBe(true);
    expect(
      pathHasWriteGrant("/srv/project-other", [{ root: "/srv/project", access: "write" }]),
    ).toBe(false);
  });
});
