import { describe, expect, test } from "vite-plus/test";
import { mergeManifests } from "./merge-latest-mac.mjs";

describe("macOS update manifest merge", () => {
  test("combines architecture files and retains the newest release date", () => {
    expect(
      mergeManifests(
        { version: "1.2.3", releaseDate: "2026-01-01T00:00:00.000Z", files: [{ url: "x64.dmg" }] },
        {
          version: "1.2.3",
          releaseDate: "2026-01-02T00:00:00.000Z",
          files: [{ url: "arm64.dmg" }],
        },
      ),
    ).toEqual({
      version: "1.2.3",
      releaseDate: "2026-01-02T00:00:00.000Z",
      files: [{ url: "x64.dmg" }, { url: "arm64.dmg" }],
    });
  });
});
