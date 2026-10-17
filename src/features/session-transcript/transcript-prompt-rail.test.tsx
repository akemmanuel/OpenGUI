// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { TranscriptPromptRail } from "./transcript-prompt-rail";

const markers = [
  { id: "u1", prompt: "First prompt", reply: "First reply" },
  { id: "u2", prompt: "Second prompt", reply: "" },
];

describe("TranscriptPromptRail", () => {
  afterEach(cleanup);

  test("marks the current prompt, previews on hover and jumps on click", () => {
    const onSelect = vi.fn();
    render(<TranscriptPromptRail markers={markers} activeId="u2" onSelect={onSelect} />);

    const second = screen.getByRole("button", { name: "Second prompt" });
    expect(second.getAttribute("aria-current")).toBe("location");

    const first = screen.getByRole("button", { name: "First prompt" });
    fireEvent.mouseEnter(first);
    expect(screen.getByRole("tooltip").textContent).toContain("First reply");

    fireEvent.click(first);
    expect(onSelect).toHaveBeenCalledWith("u1");
  });
});
