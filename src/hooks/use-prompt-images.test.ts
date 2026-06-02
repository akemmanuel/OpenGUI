import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { getImageFiles } from "@/hooks/use-prompt-images";

describe("getImageFiles", () => {
  test("keeps only image MIME files", () => {
    const image = new File([""], "image.png", { type: "image/png" });
    const text = new File([""], "notes.txt", { type: "text/plain" });
    const svg = new File([""], "icon.svg", { type: "image/svg+xml" });

    expect(getImageFiles([image, text, svg])).toEqual([image, svg]);
  });
});
