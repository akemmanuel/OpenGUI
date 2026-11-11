// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createHostFileClient, HostFileError } from "./host-file-client";

afterEach(() => vi.unstubAllGlobals());

test("Host requests preserve paths, use bearer headers, and bound text previews", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(Uint8Array.from([0x47, 0x72, 0xfc, 0xdf, 0x65])));
  const client = createHostFileClient("https://host.test/", "test-token", fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    await client.readText({
      path: "C:\\My Files\\Grüße.txt",
      name: "Grüße.txt",
      size: 5,
      modifiedAt: 0,
      textEncoding: "windows-1252",
    }),
  ).toBe("Grüße");
  const [url, options] = fetcher.mock.calls[0]!;
  const parsed = new URL(url instanceof Request ? url.url : url);
  expect(parsed.searchParams.get("path")).toBe("C:\\My Files\\Grüße.txt");
  expect(parsed.searchParams.get("maxBytes")).toBe(String(2 * 1024 * 1024));
  expect(parsed.searchParams.has("token")).toBe(false);
  expect(new Headers(options?.headers).get("authorization")).toBe("Bearer test-token");
  expect(client.pdfSource("/doc.pdf").withCredentials).toBe(false);
});

test("Host access and size refusals remain distinguishable", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = createHostFileClient("https://host.test", null, fetcher);
  fetcher.mockResolvedValueOnce(Response.json({ error: "Access denied" }, { status: 403 }));
  await expect(client.stat("/secret")).rejects.toMatchObject({ kind: "forbidden" });
  fetcher.mockResolvedValueOnce(Response.json({ error: "Size limit" }, { status: 413 }));
  await expect(client.stat("/large")).rejects.toBeInstanceOf(HostFileError);
});

test("authenticated downloads stream to the selected file without creating a blob", async () => {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      chunks.push(chunk);
    },
  });
  const picker = vi.fn().mockResolvedValue({ createWritable: async () => writable });
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: picker });
  const response = new Response("download content");
  const blob = vi.spyOn(response, "blob");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  try {
    await createHostFileClient("https://host.test", "test-token", fetcher).download(
      "/report.txt",
      "report.txt",
    );
    expect(picker).toHaveBeenCalledWith({ suggestedName: "report.txt" });
    expect(new TextDecoder().decode(chunks[0])).toBe("download content");
    expect(blob).not.toHaveBeenCalled();
  } finally {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  }
});
