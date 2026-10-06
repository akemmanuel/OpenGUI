// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { CompactionPartView } from "./CompactionPartView";
import type { TranscriptPart } from "@/protocol/session-transcript";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function part(metadata: Record<string, unknown>) {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "compaction",
    metadata,
  } as TranscriptPart & { type: "compaction" };
}

describe("CompactionPartView", () => {
  afterEach(() => cleanup());

  test("renders in-progress state while running", () => {
    render(<CompactionPartView part={part({ status: "started" })} />);
    expect(screen.getByRole("status").textContent).toContain("compaction.inProgress");
  });

  test("renders completed states", () => {
    const { rerender } = render(
      <CompactionPartView part={part({ status: "completed", reason: "threshold" })} />,
    );
    expect(screen.getByRole("status").textContent).toContain("compaction.completed");
    rerender(<CompactionPartView part={part({ status: "completed", reason: "manual" })} />);
    expect(screen.getByRole("status").textContent).toContain("compaction.completedManual");
  });

  test("renders failed state with actionable recovery hint", () => {
    render(
      <CompactionPartView
        part={part({ status: "failed", reason: "threshold", failureSource: "summary" })}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("compaction.failed");
    expect(status.textContent).toContain("compaction.failedHint");
    expect(status.textContent).not.toContain("compaction.inProgress");
  });
});
