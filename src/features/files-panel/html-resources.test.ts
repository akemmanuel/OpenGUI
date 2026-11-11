// @vitest-environment happy-dom
import { expect, test, vi } from "vite-plus/test";
import { inlineLocalHtmlResources, resolveLocalReference } from "./html-resources";

const bytes = (text: string) => new TextEncoder().encode(text);
const base64 = (text: string) => btoa(text);

test("relative, encoded, and absolute references resolve against the document folder", () => {
  expect(resolveLocalReference("Dinolino/a.png", "/p/site")).toBe("/p/site/Dinolino/a.png");
  expect(resolveLocalReference("../img/My%20Logo.png?v=2#x", "/p/site")).toBe("/p/img/My Logo.png");
  expect(resolveLocalReference("/abs/a.png", "/p/site")).toBe("/abs/a.png");
  expect(resolveLocalReference("C:\\img\\a.png", "C:\\site")).toBe("C:\\img\\a.png");
  for (const remote of [
    "https://x.test/a.png",
    "//cdn.test/a.png",
    "data:image/png;base64,AA",
    "#top",
    "",
  ])
    expect(resolveLocalReference(remote, "/p/site")).toBeNull();
});

test("local images, srcset, fonts, and stylesheets are embedded; remote URLs are left alone", async () => {
  const files: Record<string, string> = {
    "/p/site/img/a.png": "PNG-A",
    "/p/site/img/b.webp": "WEBP-B",
    "/p/site/font.woff2": "FONT",
    "/p/site/css/site.css": "body{background:url('../img/a.png')}",
    "/p/site/bg.jpg": "JPG",
  };
  const load = vi.fn(async (path: string) => (path in files ? bytes(files[path]!) : null));
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="css/site.css">
    <style>@font-face{font-family:x;src:url('font.woff2') format('woff2')}</style>
  </head><body>
    <img src="img/a.png" alt="a">
    <img src="https://remote.test/pixel.png" alt="remote">
    <img src="missing.png" alt="missing">
    <img srcset="img/a.png 1x, img/b.webp 2x" alt="set">
    <div style="background-image:url(bg.jpg)"></div>
  </body></html>`;

  const result = await inlineLocalHtmlResources(html, "/p/site/index.html", load);
  const document = new DOMParser().parseFromString(result, "text/html");
  const images = [...document.querySelectorAll("img")];

  expect(images[0]!.getAttribute("src")).toBe(`data:image/png;base64,${base64("PNG-A")}`);
  expect(images[1]!.getAttribute("src")).toBe("https://remote.test/pixel.png");
  expect(images[2]!.getAttribute("src")).toBe("missing.png");
  expect(images[3]!.getAttribute("srcset")).toBe(
    `data:image/png;base64,${base64("PNG-A")} 1x, data:image/webp;base64,${base64("WEBP-B")} 2x`,
  );
  expect(document.querySelector("div")!.getAttribute("style")).toContain(
    `url("data:image/jpeg;base64,${base64("JPG")}")`,
  );
  const styles = [...document.querySelectorAll("style")].map((style) => style.textContent);
  expect(document.querySelector("link")).toBeNull();
  // The stylesheet's own url() resolves against css/, not the document folder.
  expect(styles).toContain(`body{background:url("data:image/png;base64,${base64("PNG-A")}")}`);
  expect(styles.join("")).toContain(`url("data:font/woff2;base64,${base64("FONT")}")`);
  // Each file is read once, and remote URLs are never requested.
  expect(
    load.mock.calls.map(([path]) => path).filter((path) => path === "/p/site/img/a.png"),
  ).toHaveLength(1);
  expect(load.mock.calls.some(([path]) => path.includes("remote"))).toBe(false);
});

test("unknown file types and failing reads keep the original reference", async () => {
  const load = vi.fn(async () => {
    throw new Error("forbidden");
  });
  const result = await inlineLocalHtmlResources(
    `<img src="a.png"><img src="script.js">`,
    "/p/index.html",
    load,
  );
  expect(result).toContain(`src="a.png"`);
  expect(result).toContain(`src="script.js"`);
  expect(load).toHaveBeenCalledTimes(1);
});
