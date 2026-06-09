import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { resolveAttachmentImageSrc } from "../attachment-src";

describe("resolveAttachmentImageSrc", () => {
  test("keeps data urls unchanged", () => {
    const url = "data:image/png;base64,abc123";
    expect(resolveAttachmentImageSrc(url, "http://localhost:4096")).toBe(url);
  });

  test("serves absolute paths through the backend when server url exists", () => {
    expect(resolveAttachmentImageSrc("/tmp/image.png", "http://localhost:4096/")).toBe(
      "http://localhost:4096/api/fs/file?path=%2Ftmp%2Fimage.png",
    );
  });

  test("resolves relative paths against the base directory", () => {
    expect(resolveAttachmentImageSrc("screenshot.png", null, "/repo/project")).toBe(
      "file:///repo/project/screenshot.png",
    );
  });

  test("serves relative paths through the backend with a base directory", () => {
    expect(
      resolveAttachmentImageSrc("screenshot.png", "https://example.com/opencode", "/repo/project"),
    ).toBe(
      "https://example.com/opencode/api/fs/file?path=%2Frepo%2Fproject%2Fscreenshot.png&directory=%2Frepo%2Fproject",
    );
  });

  test("keeps unix absolute paths as file urls when no server url exists", () => {
    expect(resolveAttachmentImageSrc("/tmp/image.png")).toBe("file:///tmp/image.png");
  });

  test("converts windows absolute paths to file urls", () => {
    expect(resolveAttachmentImageSrc("C:\\temp\\image.png")).toBe("file:///C:/temp/image.png");
  });
});
