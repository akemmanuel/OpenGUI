import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { DurationLabel } from "./DurationLabel";
import type { TurnFooter } from "./types";

function renderDuration(footer: TurnFooter) {
  return renderToStaticMarkup(<DurationLabel footer={footer} />);
}

describe("DurationLabel", () => {
  test("renders explicit turn duration in whole seconds", () => {
    expect(renderDuration({ running: false, durationMs: 61_234 })).toBe("<span>1m 01s</span>");
  });

  test("derives completed turn duration from timestamps", () => {
    expect(
      renderDuration({
        running: false,
        startedAt: 1_000,
        completedAt: 3_500,
      }),
    ).toBe("<span>2s</span>");
  });

  test("omits zero, negative, and missing durations", () => {
    expect(renderDuration({ running: false, durationMs: 0 })).toBe("");
    expect(renderDuration({ running: false, startedAt: 5_000, completedAt: 4_000 })).toBe("");
    expect(renderDuration({ running: false })).toBe("");
  });
});
