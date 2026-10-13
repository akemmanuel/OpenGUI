// @vitest-environment happy-dom

import { describe, expect, test } from "vite-plus/test";
import { topVisibleTimestamp } from "./scroll-time-indicator";

function rect(top: number, bottom: number) {
  return () => ({ top, bottom }) as DOMRect;
}

function transcript(rows: Array<{ created?: string; top: number; bottom: number }>) {
  const container = document.createElement("div");
  container.getBoundingClientRect = rect(100, 600);
  for (const row of rows) {
    const element = document.createElement("div");
    if (row.created !== undefined) element.dataset.createdAt = row.created;
    element.getBoundingClientRect = rect(row.top, row.bottom);
    container.append(element);
  }
  return container;
}

describe("scroll time indicator", () => {
  test("reports the first row still visible at the top of the viewport", () => {
    const container = transcript([
      { created: "1000", top: -300, bottom: 40 },
      { created: "2000", top: 40, bottom: 140 },
      { created: "3000", top: 140, bottom: 400 },
    ]);
    expect(topVisibleTimestamp(container)).toBe(2000);
  });

  test("never invents a time for rows without a reliable timestamp", () => {
    const container = transcript([{ created: "0", top: 100, bottom: 300 }]);
    expect(topVisibleTimestamp(container)).toBeUndefined();
    expect(topVisibleTimestamp(transcript([]))).toBeUndefined();
  });
});
