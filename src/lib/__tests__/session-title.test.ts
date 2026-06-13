import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { cleanSessionTitle } from "@/lib/session-title";

describe("cleanSessionTitle", () => {
  test("removes raw chat role prefixes from imported Session titles", () => {
    expect(cleanSessionTitle("Human: verbinde die Datenbank")).toBe("verbinde die Datenbank");
    expect(cleanSessionTitle("Assistant: Komponente prüfen")).toBe("Komponente prüfen");
    expect(cleanSessionTitle("User: fix sidebar sessions")).toBe("fix sidebar sessions");
  });

  test("keeps meaningful titles untouched", () => {
    expect(cleanSessionTitle("OpenCode Sidebar Fix")).toBe("OpenCode Sidebar Fix");
  });
});
