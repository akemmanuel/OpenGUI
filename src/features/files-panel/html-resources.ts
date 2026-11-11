/**
 * Embed an HTML document's local images, fonts, and stylesheets as `data:` URLs.
 *
 * The preview iframe has no base URL and its policy blocks every request, so
 * `<img src="images/logo.png">` or `url('font.woff2')` would never load. The
 * files are read through the Host (which checks access) and inlined instead;
 * remote URLs stay blocked.
 */
import { fileExtension, hostParent, isAbsoluteHostPath, joinHostPath } from "@/lib/host-files";

/** Reads one file's bytes, or null when it is missing, forbidden, or too large. */
export type ResourceLoader = (path: string, signal?: AbortSignal) => Promise<Uint8Array | null>;

const MAX_RESOURCES = 200;
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  // SVG used as an image or background never runs its scripts.
  svg: "image/svg+xml",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

const CSS_URL = /url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi;

/** Host path for a document-relative reference, or null for remote or in-page URLs. */
export function resolveLocalReference(reference: string, baseDirectory: string): string | null {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
  // Any scheme (`https:`, `data:`, `mailto:`) except a Windows drive letter.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) return null;
  const withoutSuffix = trimmed.replace(/[?#].*$/, "");
  if (!withoutSuffix) return null;
  let decoded = withoutSuffix;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    // Keep a reference with a stray `%` as written.
  }
  return isAbsoluteHostPath(decoded) ? decoded : joinHostPath(baseDirectory, decoded);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

class ResourceInliner {
  private readonly cache = new Map<string, Promise<Uint8Array | null>>();
  private totalBytes = 0;

  constructor(
    private readonly load: ResourceLoader,
    private readonly signal?: AbortSignal,
  ) {}

  private bytes(path: string): Promise<Uint8Array | null> {
    let pending = this.cache.get(path);
    if (!pending) {
      if (this.cache.size >= MAX_RESOURCES) return Promise.resolve(null);
      pending = this.load(path, this.signal).then(
        (bytes) => {
          if (!bytes || bytes.length > MAX_RESOURCE_BYTES) return null;
          if (this.totalBytes + bytes.length > MAX_TOTAL_BYTES) return null;
          this.totalBytes += bytes.length;
          return bytes;
        },
        () => null,
      );
      this.cache.set(path, pending);
    }
    return pending;
  }

  /** `data:` URL for an image or font reference, or null to leave it as written. */
  async dataUrl(reference: string, baseDirectory: string): Promise<string | null> {
    const path = resolveLocalReference(reference, baseDirectory);
    if (!path) return null;
    const mime = MIME_TYPES[fileExtension(path)];
    if (!mime) return null;
    const bytes = await this.bytes(path);
    return bytes ? `data:${mime};base64,${toBase64(bytes)}` : null;
  }

  async stylesheet(reference: string, baseDirectory: string): Promise<string | null> {
    const path = resolveLocalReference(reference, baseDirectory);
    if (!path || fileExtension(path) !== "css") return null;
    const bytes = await this.bytes(path);
    if (!bytes) return null;
    return this.css(new TextDecoder().decode(bytes), hostParent(path));
  }

  /** Rewrite `url(...)` references; a stylesheet resolves them against its own folder. */
  async css(text: string, baseDirectory: string): Promise<string> {
    const references = new Set<string>();
    for (const match of text.matchAll(CSS_URL)) references.add(match[2]!);
    if (references.size === 0) return text;
    const replacements = new Map<string, string>();
    await Promise.all(
      [...references].map(async (reference) => {
        const url = await this.dataUrl(reference, baseDirectory);
        if (url) replacements.set(reference, url);
      }),
    );
    return text.replace(CSS_URL, (whole, _quote: string, reference: string) => {
      const url = replacements.get(reference);
      return url ? `url("${url}")` : whole;
    });
  }

  async srcset(value: string, baseDirectory: string): Promise<string> {
    const candidates = await Promise.all(
      value.split(",").map(async (candidate) => {
        const [reference = "", ...descriptor] = candidate.trim().split(/\s+/);
        const url = await this.dataUrl(reference, baseDirectory);
        return url ? [url, ...descriptor].join(" ") : candidate.trim();
      }),
    );
    return candidates.join(", ");
  }
}

/**
 * Return `html` with local resources embedded. `htmlPath` is the document's
 * Host path; relative references resolve against its folder.
 */
export async function inlineLocalHtmlResources(
  html: string,
  htmlPath: string,
  load: ResourceLoader,
  signal?: AbortSignal,
): Promise<string> {
  // A parsed document has no browsing context: nothing in it loads or runs.
  const document = new DOMParser().parseFromString(html, "text/html");
  const directory = hostParent(htmlPath);
  const inliner = new ResourceInliner(load, signal);
  const tasks: Promise<void>[] = [];

  const rewriteAttribute = (selector: string, attribute: string) => {
    for (const element of document.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      tasks.push(
        inliner.dataUrl(value, directory).then((url) => {
          if (url) element.setAttribute(attribute, url);
        }),
      );
    }
  };
  rewriteAttribute("img[src], input[type='image'][src]", "src");
  rewriteAttribute("video[poster]", "poster");
  rewriteAttribute("image[href]", "href");
  rewriteAttribute("image[xlink\\:href]", "xlink:href");

  for (const element of document.querySelectorAll("img[srcset], source[srcset]")) {
    const value = element.getAttribute("srcset");
    if (!value) continue;
    tasks.push(
      inliner.srcset(value, directory).then((next) => element.setAttribute("srcset", next)),
    );
  }

  for (const style of document.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    tasks.push(
      inliner.css(text, directory).then((next) => {
        if (next !== text) style.textContent = next;
      }),
    );
  }

  for (const element of document.querySelectorAll("[style]")) {
    const text = element.getAttribute("style") ?? "";
    if (!text.includes("url(")) continue;
    tasks.push(
      inliner.css(text, directory).then((next) => {
        if (next !== text) element.setAttribute("style", next);
      }),
    );
  }

  for (const link of document.querySelectorAll("link[rel~='stylesheet' i][href]")) {
    tasks.push(
      inliner.stylesheet(link.getAttribute("href")!, directory).then((css) => {
        if (css === null) return;
        const style = document.createElement("style");
        const media = link.getAttribute("media");
        if (media) style.setAttribute("media", media);
        style.textContent = css;
        link.replaceWith(style);
      }),
    );
  }

  await Promise.all(tasks);
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return `<!doctype html>${document.documentElement.outerHTML}`;
}
