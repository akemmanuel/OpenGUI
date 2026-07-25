// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { MessageListViewportShell } from "./MessageListViewportShell";

vi.mock("@/components/ui/spinner", () => ({
  Spinner: () => <span role="status">loading</span>,
}));
vi.mock("@/components/message-list/EmptySessionOverview", () => ({
  EmptySessionOverview: () => <span>empty</span>,
}));

describe("MessageListViewportShell", () => {
  afterEach(() => vi.useRealTimers());

  test("does not flash a spinner when loading completes quickly", () => {
    vi.useFakeTimers();
    const view = render(
      <MessageListViewportShell viewport={{ kind: "loading" }}>
        transcript
      </MessageListViewportShell>,
    );

    expect(screen.queryByRole("status")).toBeNull();
    void act(() => vi.advanceTimersByTime(100));
    view.rerender(
      <MessageListViewportShell viewport={{ kind: "transcript" }}>
        transcript
      </MessageListViewportShell>,
    );

    expect(screen.getByText("transcript")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("shows progress when loading lasts beyond the delay", () => {
    vi.useFakeTimers();
    render(
      <MessageListViewportShell viewport={{ kind: "loading" }}>
        transcript
      </MessageListViewportShell>,
    );

    void act(() => vi.advanceTimersByTime(150));

    expect(screen.getByRole("status")).toBeTruthy();
  });
});
