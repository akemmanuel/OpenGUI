import { describe, expect, test } from "vite-plus/test";
import { measureInitialJavaScript } from "./bundle-budget";

describe("initial JavaScript bundle budget", () => {
  test("counts only JavaScript loaded by the entry HTML", () => {
    const result = measureInitialJavaScript(
      '<script type="module" src="./assets/index-abc.js"></script><link rel="modulepreload" href="./assets/vendor.js">',
      new Map([
        ["assets/index-abc.js", 900_000],
        ["assets/vendor.js", 300_000],
        ["assets/lazy.js", 2_000_000],
      ]),
    );
    expect(result).toEqual({
      assets: ["assets/index-abc.js", "assets/vendor.js"],
      bytes: 1_200_000,
    });
  });
});
