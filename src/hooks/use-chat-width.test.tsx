// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageSet } from "@/lib/persistence/storage";
import { useChatWidth } from "./use-chat-width";

function WidthDisplay() {
  const [width, setWidth] = useChatWidth();
  return <button onClick={() => setWidth(width === 100 ? 70 : 100)}>{width}</button>;
}

describe("chat width setting", () => {
  afterEach(() => {
    cleanup();
    storageSet(STORAGE_KEYS.CHAT_WIDTH, "standard");
  });

  test("defaults to standard for missing and invalid values", () => {
    storageSet(STORAGE_KEYS.CHAT_WIDTH, "invalid");
    render(<WidthDisplay />);
    expect(screen.getByRole("button").textContent).toBe("70");
  });

  test("reads legacy full width and supports percentages", () => {
    storageSet(STORAGE_KEYS.CHAT_WIDTH, "full");
    render(<WidthDisplay />);
    expect(screen.getByRole("button").textContent).toBe("100");
    act(() => storageSet(STORAGE_KEYS.CHAT_WIDTH, "83"));
    expect(screen.getByRole("button").textContent).toBe("83");
    act(() => storageSet(STORAGE_KEYS.CHAT_WIDTH, "101"));
    expect(screen.getByRole("button").textContent).toBe("70");
  });

  test("updates mounted consumers immediately and persists the choice", () => {
    render(
      <>
        <WidthDisplay />
        <WidthDisplay />
      </>,
    );
    fireEvent.click(screen.getAllByRole("button")[0]!);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "100",
      "100",
    ]);
    expect(localStorage.getItem(STORAGE_KEYS.CHAT_WIDTH)).toBe("100");
    cleanup();
    render(<WidthDisplay />);
    expect(screen.getByRole("button").textContent).toBe("100");
  });
});
