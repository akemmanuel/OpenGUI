import { describe, expect, test } from "vite-plus/test";
import type { TranscriptMessageEntry, TranscriptPart } from "@/protocol/session-transcript";
import {
  collectChatFiles,
  hostBasename,
  hostParent,
  isolateHtmlDocument,
  joinHostPath,
  parseFileLink,
  previewKindFor,
  relativeHostPath,
  resolveHostPath,
  wrapLocalLinkTargetsWithSpaces,
} from "./host-files";

describe("parseFileLink", () => {
  test("reads local paths, file URLs, Windows paths and line suffixes", () => {
    expect(parseFileLink("/home/a/Uebersicht.pdf")).toEqual({
      path: "/home/a/Uebersicht.pdf",
      line: null,
    });
    expect(parseFileLink("contact.php:24")).toEqual({ path: "contact.php", line: 24 });
    expect(parseFileLink("src/foo.ts:12")).toEqual({ path: "src/foo.ts", line: 12 });
    expect(parseFileLink("./src/foo.ts:12:4")).toEqual({ path: "./src/foo.ts", line: 12 });
    expect(parseFileLink("src/foo.ts#L7-L9")).toEqual({ path: "src/foo.ts", line: 7 });
    expect(parseFileLink("file:///home/a/My%20File.md")).toEqual({
      path: "/home/a/My File.md",
      line: null,
    });
    expect(parseFileLink("file:///C:/work/x.txt")).toEqual({ path: "C:/work/x.txt", line: null });
    expect(parseFileLink("C:\\work\\x.txt")).toEqual({ path: "C:\\work\\x.txt", line: null });
    expect(parseFileLink("README.md")).toEqual({ path: "README.md", line: null });
    expect(parseFileLink("dinolinos.html#raetsel")).toEqual({
      path: "dinolinos.html",
      line: null,
    });
    expect(parseFileLink("site/page.html?v=2")).toEqual({ path: "site/page.html", line: null });
  });

  test("leaves web links, anchors and bare words alone", () => {
    expect(parseFileLink("https://example.com/a.pdf")).toBeNull();
    expect(parseFileLink("https://example.com:443")).toBeNull();
    expect(parseFileLink("mailto:a@b.de")).toBeNull();
    expect(parseFileLink("#section")).toBeNull();
    expect(parseFileLink("www.example.com")).toBeNull();
    expect(parseFileLink("//example.com/docs")).toBeNull();
    expect(parseFileLink("setup")).toBeNull();
    expect(parseFileLink("")).toBeNull();
  });
});

describe("wrapLocalLinkTargetsWithSpaces", () => {
  test("wraps local link targets with spaces, outside code fences only", () => {
    expect(
      wrapLocalLinkTargetsWithSpaces("[PDF](/home/Wolter Kunde/x.pdf) and [w](https://a.b)"),
    ).toBe("[PDF](</home/Wolter Kunde/x.pdf>) and [w](https://a.b)");
    const fenced = "```\n[PDF](/home/Wolter Kunde/x.pdf)\n```";
    expect(wrapLocalLinkTargetsWithSpaces(fenced)).toBe(fenced);
    const inline = "`[PDF](/home/My Folder/x.pdf)`";
    expect(wrapLocalLinkTargetsWithSpaces(inline)).toBe(inline);
    const tildes = "~~~md\n[PDF](/home/My Folder/x.pdf)\n~~~";
    expect(wrapLocalLinkTargetsWithSpaces(tildes)).toBe(tildes);
    expect(wrapLocalLinkTargetsWithSpaces("[a](/no-spaces.pdf)")).toBe("[a](/no-spaces.pdf)");
  });
});

describe("host paths", () => {
  test("join, resolve, parent, basename and relative on POSIX and Windows", () => {
    expect(joinHostPath("/home/a/", "src/../docs/./x.md")).toBe("/home/a/docs/x.md");
    expect(joinHostPath("C:\\work", "src\\a.ts")).toBe("C:\\work\\src\\a.ts");
    expect(joinHostPath("/", "docs/a.txt")).toBe("/docs/a.txt");
    expect(resolveHostPath("x.md", null)).toBeNull();
    expect(resolveHostPath("/abs/x.md/", "/ignored")).toBe("/abs/x.md");
    expect(hostParent("/home/a/x.md")).toBe("/home/a");
    expect(hostParent("/home")).toBe("/");
    expect(hostParent("C:\\work")).toBe("C:\\");
    expect(hostBasename("/home/a/x.md")).toBe("x.md");
    expect(relativeHostPath("/home/a", "/home/a/src/x.ts")).toBe("src/x.ts");
    expect(relativeHostPath("/home/a", "/home/a")).toBe("");
    expect(relativeHostPath("/home/a", "/home/ab/x.ts")).toBeNull();
  });
});

describe("previewKindFor", () => {
  test("picks a previewer from the name and the Host's text sniffing", () => {
    expect(previewKindFor("a.PNG", null)).toBe("image");
    expect(previewKindFor("a.pdf", null)).toBe("pdf");
    expect(previewKindFor("index.html", "utf-8")).toBe("html");
    expect(previewKindFor("NOTES.md", "utf-8")).toBe("markdown");
    expect(previewKindFor("contact.php", "windows-1252")).toBe("text");
    expect(previewKindFor("Dockerfile", "utf-8")).toBe("text");
    expect(previewKindFor("chart.svg", "utf-8")).toBe("html");
    expect(previewKindFor("data.csv", "utf-8")).toBe("csv");
    expect(previewKindFor("data.xlsx", null)).toBe("none");
  });
});

describe("isolateHtmlDocument", () => {
  test("puts a no-network policy into the head", () => {
    expect(isolateHtmlDocument("<html><head><title>x</title></head></html>")).toMatch(
      /^<!doctype html><meta http-equiv="Content-Security-Policy"[^>]*><html><head><title>/,
    );
    expect(isolateHtmlDocument("<p>hi</p>")).toMatch(/^<!doctype html><meta [^>]*><p>hi<\/p>$/);
  });
});

describe("collectChatFiles", () => {
  const message = (
    id: string,
    created: number,
    parts: TranscriptPart[],
  ): TranscriptMessageEntry => ({
    info: { id, sessionID: "s", role: "assistant", time: { created } },
    parts,
  });
  const tool = (
    id: string,
    name: string,
    input: unknown,
    end: number,
    status = "completed",
    metadata?: unknown,
  ): TranscriptPart => ({
    id,
    type: "tool",
    tool: name,
    state: { status, input, time: { start: end - 1, end }, metadata },
  });

  test("lists written and edited files newest first, resolved against the project", () => {
    const files = collectChatFiles(
      [
        message("m1", 1, [
          tool("t1", "write", { filePath: "Export/a.pdf" }, 10),
          tool("t2", "edit", { filePath: "/p/NOTES.md" }, 20),
          tool("t3", "read", { filePath: "/p/ignored.md" }, 30),
          tool("t4", "write", { filePath: "/p/failed.txt" }, 40, "error"),
        ]),
        message("m2", 2, [tool("t5", "edit", { filePath: "/p/Export/a.pdf" }, 50)]),
      ],
      "/p",
    );
    expect(files).toEqual([
      { path: "/p/Export/a.pdf", change: "created", time: 50 },
      { path: "/p/NOTES.md", change: "changed", time: 20 },
    ]);
  });
});
