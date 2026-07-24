// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueDragHandle } from "./QueueList";
import { QueueList } from "./QueueList";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/identity/ActorAttribution", () => ({ ActorAttribution: () => null }));

afterEach(cleanup);

describe("Queue drag handle", () => {
  test("is keyboard operable for the queue's KeyboardSensor", () => {
    const markup = renderToStaticMarkup(
      <QueueDragHandle label="Reorder queued prompt" dragHandleProps={{ tabIndex: 0 }} />,
    );

    expect(markup).toMatch(/^<button [^>]*type="button"/);
    expect(markup).toContain('aria-label="Reorder queued prompt"');
    expect(markup).toContain('tabindex="0"');
  });
});

describe("queued prompt actions", () => {
  test("edits trimmed text, sends, removes, and exposes mode metadata", async () => {
    const onEdit = vi.fn();
    const onSendNow = vi.fn();
    const onRemove = vi.fn();
    render(
      <QueueList
        items={[{ id: "one", text: "Original", mode: "interrupt", variant: "fast" }]}
        onEdit={onEdit}
        onSendNow={onSendNow}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText("queueList.interrupt")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "queueList.sendNow" }));
    await userEvent.click(screen.getByRole("button", { name: "queueList.remove" }));
    await userEvent.click(screen.getByRole("button", { name: "queueList.moreActions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "queueList.edit" }));
    const editor = screen.getByRole("textbox");
    await userEvent.clear(editor);
    await userEvent.type(editor, "  Revised  {Enter}");

    expect(onSendNow).toHaveBeenCalledWith("one");
    expect(onRemove).toHaveBeenCalledWith("one");
    expect(onEdit).toHaveBeenCalledWith("one", "Revised");
  });

  test("Escape cancels editing and restores focus to the menu trigger", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    const onEdit = vi.fn();
    render(<QueueList items={[{ id: "one", text: "Keep me" }]} onEdit={onEdit} />);
    const trigger = screen.getByRole("button", { name: "queueList.moreActions" });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "queueList.edit" }));
    await userEvent.type(screen.getByRole("textbox"), " changed{Escape}");

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "queueList.moreActions" }),
      ),
    );
    expect(screen.getByText("Keep me")).toBeTruthy();
    expect(onEdit).not.toHaveBeenCalled();
  });

  test("moves focus into the actions menu and Escape closes it and restores the trigger", async () => {
    render(<QueueList items={[{ id: "one", text: "Queued work" }]} />);
    const trigger = screen.getByRole("button", { name: "queueList.moreActions" });
    await userEvent.click(trigger);

    const menu = screen.getByRole("menu");
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("does not render an empty queue", () => {
    const { container } = render(<QueueList items={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
