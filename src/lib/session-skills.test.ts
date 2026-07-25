import { describe, expect, test } from "vite-plus/test";
import { defaultEnabledSkillNames, sessionSkillsKey } from "./session-skills";

describe("session skills", () => {
  test("starts with auto skills enabled and manual skills disabled", () => {
    expect(
      defaultEnabledSkillNames([
        { name: "auto", manual: false },
        { name: "manual", manual: true },
      ]),
    ).toEqual(["auto"]);
  });

  test("uses a Session key when available and a normalized pending key otherwise", () => {
    expect(sessionSkillsKey("session-1", "/project")).toBe("session:session-1");
    expect(sessionSkillsKey(null, "/project/")).toBe("pending:/project");
  });
});
