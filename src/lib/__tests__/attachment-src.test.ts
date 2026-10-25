import { describe, expect, test } from "vite-plus/test";
import {
  classifyMarkdownImageSource,
  isAttachmentHostUrl,
  resolveAttachmentAuthToken,
  resolveAttachmentBaseUrl,
  resolveAttachmentImageSrc,
} from "../attachment-src";

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
      resolveAttachmentImageSrc("screenshot.png", "https://example.com/host", "/repo/project"),
    ).toBe(
      "https://example.com/host/api/fs/file?path=%2Frepo%2Fproject%2Fscreenshot.png&directory=%2Frepo%2Fproject",
    );
  });

  test("keeps unix absolute paths as file urls when no server url exists", () => {
    expect(resolveAttachmentImageSrc("/tmp/image.png")).toBe("file:///tmp/image.png");
  });

  test("converts windows absolute paths to file urls", () => {
    expect(resolveAttachmentImageSrc("C:\\temp\\image.png")).toBe("file:///C:/temp/image.png");
  });

  test("does not join windows drive or UNC paths onto the project directory", () => {
    expect(
      resolveAttachmentImageSrc("C:\\Users\\me\\out.png", "http://127.0.0.1:1", "C:\\proj"),
    ).toBe("http://127.0.0.1:1/api/fs/file?path=C%3A%5CUsers%5Cme%5Cout.png");
    expect(
      resolveAttachmentImageSrc("\\\\nas\\share\\out.png", "http://127.0.0.1:1", "C:\\proj"),
    ).toBe("http://127.0.0.1:1/api/fs/file?path=%5C%5Cnas%5Cshare%5Cout.png");
  });
});

describe("classifyMarkdownImageSource", () => {
  test("accepts relative, POSIX, and Windows image paths", () => {
    expect(classifyMarkdownImageSource("maus-auf-dem-mars.png")).toEqual({
      kind: "path",
      path: "maus-auf-dem-mars.png",
    });
    expect(classifyMarkdownImageSource("/Users/me/Desktop/shot.JPG")).toEqual({
      kind: "path",
      path: "/Users/me/Desktop/shot.JPG",
    });
    expect(classifyMarkdownImageSource("C:\\Users\\me\\shot.webp")).toEqual({
      kind: "path",
      path: "C:\\Users\\me\\shot.webp",
    });
  });

  test("decodes markdown percent-encoding (spaces, umlauts, backslashes)", () => {
    expect(classifyMarkdownImageSource("Bilder/M%C3%A4use%20Mars.png")).toEqual({
      kind: "path",
      path: "Bilder/Mäuse Mars.png",
    });
    expect(classifyMarkdownImageSource("C:%5CUsers%5Cme%5Cshot.png")).toEqual({
      kind: "path",
      path: "C:\\Users\\me\\shot.png",
    });
  });

  test("turns file urls into Host paths", () => {
    expect(classifyMarkdownImageSource("file:///home/me/a.png")).toEqual({
      kind: "path",
      path: "/home/me/a.png",
    });
    expect(classifyMarkdownImageSource("file:///C:/Users/me/a.png")).toEqual({
      kind: "path",
      path: "C:/Users/me/a.png",
    });
  });

  test("keeps inline raster data urls", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(classifyMarkdownImageSource(src)).toEqual({ kind: "data", src });
  });

  test("rejects remote, active, and non-image sources", () => {
    expect(classifyMarkdownImageSource("https://tracker.example/pixel.png")).toBeNull();
    expect(classifyMarkdownImageSource("http://127.0.0.1/a.png")).toBeNull();
    expect(classifyMarkdownImageSource("javascript:alert(1)//.png")).toBeNull();
    expect(classifyMarkdownImageSource("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(classifyMarkdownImageSource("notes/secret.txt")).toBeNull();
    expect(classifyMarkdownImageSource("")).toBeNull();
  });
});

describe("resolveAttachmentAuthToken", () => {
  test("never sends a credential to the Desktop Local sidecar", () => {
    expect(
      resolveAttachmentAuthToken({ isLocal: true, authToken: "secret" }, { kind: "electron" }),
    ).toBeNull();
  });

  test("uses the Remote Host token on desktop and web", () => {
    expect(
      resolveAttachmentAuthToken({ isLocal: false, authToken: "ogk_1" }, { kind: "electron" }),
    ).toBe("ogk_1");
    expect(resolveAttachmentAuthToken({ isLocal: true, authToken: "ogk_2" }, { kind: "web" })).toBe(
      "ogk_2",
    );
  });

  test("relies on cookies when no token is configured", () => {
    expect(
      resolveAttachmentAuthToken({ isLocal: false, authToken: "" }, { kind: "web" }),
    ).toBeNull();
  });
});

describe("isAttachmentHostUrl", () => {
  const base = "https://host.example";

  test("accepts preview urls on the Host's origin", () => {
    expect(isAttachmentHostUrl(`${base}/api/fs/file?path=%2Fa.png`, base)).toBe(true);
    expect(isAttachmentHostUrl("https://host.example:443/x.png", `${base}/`)).toBe(true);
  });

  test("rejects other origins, schemes, and unparsable values", () => {
    expect(isAttachmentHostUrl("https://attacker.example/x.png", base)).toBe(false);
    expect(isAttachmentHostUrl("https://host.example.attacker.example/x.png", base)).toBe(false);
    expect(isAttachmentHostUrl("http://host.example/x.png", base)).toBe(false);
    expect(isAttachmentHostUrl("https://host.example:8443/x.png", base)).toBe(false);
    expect(isAttachmentHostUrl("blob:https://host.example/1", base)).toBe(false);
    expect(isAttachmentHostUrl("/api/fs/file?path=%2Fa.png", base)).toBe(false);
    expect(isAttachmentHostUrl(`${base}/x.png`, null)).toBe(false);
    expect(isAttachmentHostUrl(`${base}/x.png`, "not a url")).toBe(false);
  });
});

describe("resolveAttachmentBaseUrl", () => {
  const electron = { kind: "electron" as const, backendUrl: "http://127.0.0.1:36627" };

  test("uses the Desktop Local sidecar instead of the stored default url", () => {
    expect(
      resolveAttachmentBaseUrl({ isLocal: true, serverUrl: "http://127.0.0.1:4096" }, electron),
    ).toBe("http://127.0.0.1:36627");
  });

  test("keeps remote workspace urls on desktop", () => {
    expect(
      resolveAttachmentBaseUrl({ isLocal: false, serverUrl: "https://host.example" }, electron),
    ).toBe("https://host.example");
  });

  test("keeps the configured url in the web shell", () => {
    expect(
      resolveAttachmentBaseUrl(
        { isLocal: true, serverUrl: "https://gui.example" },
        { kind: "web", backendUrl: null },
      ),
    ).toBe("https://gui.example");
  });

  test("falls back to file urls while the sidecar url is unknown", () => {
    expect(
      resolveAttachmentBaseUrl(
        { isLocal: true, serverUrl: "http://127.0.0.1:4096" },
        {
          kind: "electron",
          backendUrl: null,
        },
      ),
    ).toBeNull();
  });
});
