import { describe, expect, it } from "vite-plus/test";
import { splitImageMentions } from "./image-mentions";

function imagePaths(text: string): string[] {
  return splitImageMentions(text).flatMap((segment) =>
    segment.type === "image" ? [segment.path] : [],
  );
}

describe("splitImageMentions", () => {
  it("finds uploads in Project folders without spaces", () => {
    expect(imagePaths("@/root/Websites/alaaddin-calendar/.opengui-uploads/3dc9.png Test")).toEqual([
      "/root/Websites/alaaddin-calendar/.opengui-uploads/3dc9.png",
    ]);
  });

  it("finds uploads in Project folders with spaces", () => {
    const path = "/home/tobias/Dokumente/Oliver Heindl/Eventmiet24/.opengui-uploads/d495.png";
    expect(splitImageMentions(`@${path} schau mal`)).toEqual([
      { type: "image", token: `@${path}`, path, filename: "d495.png" },
      { type: "text", text: " schau mal" },
    ]);
  });

  it("finds Windows paths with spaces", () => {
    expect(imagePaths("@C:\\Users\\Jane Doe\\Pictures\\shot.jpg")).toEqual([
      "C:\\Users\\Jane Doe\\Pictures\\shot.jpg",
    ]);
  });

  it("finds Windows network share paths with spaces", () => {
    expect(imagePaths("@\\\\nas\\Team Share\\Site\\shot.png")).toEqual([
      "\\\\nas\\Team Share\\Site\\shot.png",
    ]);
  });

  it("finds macOS paths with spaces", () => {
    expect(imagePaths("@/Users/Jane Doe/My Site/.opengui-uploads/abc.png hi")).toEqual([
      "/Users/Jane Doe/My Site/.opengui-uploads/abc.png",
    ]);
  });

  it("keeps consecutive mentions apart", () => {
    expect(imagePaths("@/a b/one.png @/c d/two.webp")).toEqual(["/a b/one.png", "/c d/two.webp"]);
  });

  it("does not swallow prose after a mention", () => {
    expect(imagePaths("@/tmp/one.png and then two.png")).toEqual(["/tmp/one.png"]);
  });

  it("ends relative mentions at whitespace", () => {
    expect(imagePaths("@docs/my shot.png")).toEqual([]);
    expect(imagePaths("@docs/shot.png")).toEqual(["docs/shot.png"]);
  });

  it("ignores non-image mentions", () => {
    expect(imagePaths("@/home/Some Folder/notes.md")).toEqual([]);
  });
});
