import { describe, expect, test, vi } from "vite-plus/test";
import { fetchProviderIcons } from "./fetch-provider-icons";

describe("provider icon synchronization", () => {
  test("writes only valid SVG responses and reports failures", async () => {
    const writeFile = vi.fn();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api.json")) return new Response(JSON.stringify({ alpha: {}, beta: {} }));
      if (url.endsWith("/alpha.svg")) return new Response("<svg>alpha</svg>");
      return new Response("missing", { status: 404 });
    });

    const result = await fetchProviderIcons({
      modelsUrl: "https://models.example",
      iconsDir: "/icons",
      fetch,
      mkdir: vi.fn(),
      writeFile,
    });

    expect(result).toEqual({ succeeded: ["alpha"], failed: ["beta"] });
    expect(writeFile).toHaveBeenCalledWith("/icons/alpha.svg", "<svg>alpha</svg>");
    expect(writeFile).not.toHaveBeenCalledWith("/icons/beta.svg", expect.anything());
  });
});
