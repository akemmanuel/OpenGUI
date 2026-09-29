// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageSet } from "@/lib/persistence/storage";
import { useChatWidth } from "./use-chat-width";

function WidthDisplay() {
  const [width, setWidth] = useChatWidth();
  return <button onClick={() => setWidth(width === "full" ? "standard" : "full")}>{width}</button>;
}

describe("chat width setting", () => {
  afterEach(() => {
    cleanup();
    storageSet(STORAGE_KEYS.CHAT_WIDTH, "standard");
  });

  test("defaults to standard for missing and invalid values", () => {
    storageSet(STORAGE_KEYS.CHAT_WIDTH, "invalid");
    render(<WidthDisplay />);
    expect(screen.getByRole("button").textContent).toBe("standard");
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
      "full",
      "full",
    ]);
    expect(localStorage.getItem(STORAGE_KEYS.CHAT_WIDTH)).toBe("full");
    cleanup();
    render(<WidthDisplay />);
    expect(screen.getByRole("button").textContent).toBe("full");
  });
});
