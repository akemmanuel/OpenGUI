import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { findFileMentionTrigger } from "@/hooks/use-file-mention";

describe("findFileMentionTrigger", () => {
  test("detects a mention at the start of the prompt", () => {
    expect(findFileMentionTrigger("@src", 4)).toEqual({ anchor: 0, query: "src" });
  });

  test("detects a mention after whitespace", () => {
    expect(findFileMentionTrigger("open @src/App", 13)).toEqual({ anchor: 5, query: "src/App" });
  });

  test("returns an empty query for a bare trigger", () => {
    expect(findFileMentionTrigger("open @", 6)).toEqual({ anchor: 5, query: "" });
  });

  test("ignores mid-word at signs", () => {
    expect(findFileMentionTrigger("email a@b", 9)).toBeNull();
  });

  test("stops scanning at whitespace", () => {
    expect(findFileMentionTrigger("@old now", 8)).toBeNull();
  });
});
