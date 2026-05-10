import { expect, test } from "@voidzero-dev/vite-plus-test";
import { parseUnifiedDiff } from "@/lib/diff";

test("parseUnifiedDiff ignores headers and counts changed lines", () => {
  const diff = parseUnifiedDiff(`diff --git a/a.txt b/a.txt
index abc..def 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 same
-old
+new
 keep
\\ No newline at end of file`);

  expect(diff?.added).toBe(1);
  expect(diff?.removed).toBe(1);
  expect(diff?.lines).toEqual([
    { type: "same", text: "same" },
    { type: "remove", text: "old" },
    { type: "add", text: "new" },
    { type: "same", text: "keep" },
  ]);
});
