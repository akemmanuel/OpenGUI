import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { formatTimeAgo } from "./time";

describe("formatTimeAgo", () => {
  afterEach(() => vi.useRealTimers());

  test.each([
    [30_000, "just now"],
    [5 * 60_000, "5m ago"],
    [3 * 60 * 60_000, "3h ago"],
    [8 * 24 * 60 * 60_000, "8d ago"],
    [65 * 24 * 60 * 60_000, "2mo ago"],
  ])("formats an age of %i milliseconds", (age, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    expect(formatTimeAgo(Date.now() - age)).toBe(expected);
  });

  test("accepts ISO dates and rejects invalid dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    expect(formatTimeAgo("2026-07-24T11:58:00.000Z")).toBe("2m ago");
    expect(formatTimeAgo("not-a-date")).toBe("");
  });
});
