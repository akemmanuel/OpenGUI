import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { describe, expect, test } from "vite-plus/test";
import { processImageFile } from "./image.ts";

describe("processImageFile", () => {
  test("downscales images beyond Pi's inline dimension limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengui-image-"));
    const path = join(directory, "wide.png");
    const source = new PhotonImage(new Uint8Array(2_001 * 4).fill(255), 2_001, 1);
    try {
      await writeFile(path, source.get_bytes());
    } finally {
      source.free();
    }

    const processed = await processImageFile(path);

    expect(processed).toMatchObject({
      type: "image",
      note: expect.stringContaining("original 2001x1, displayed at 2000x1"),
    });
    const resized = PhotonImage.new_from_byteslice(Buffer.from(processed!.data, "base64"));
    try {
      expect(resized.get_width()).toBe(2_000);
      expect(resized.get_height()).toBe(1);
    } finally {
      resized.free();
    }
  });
});
