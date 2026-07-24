// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { tag?: string }) => (values?.tag ? `${key}:${values.tag}` : key),
  }),
}));

import { SessionMenuContent, type SessionMenuSlots } from "./SessionMenuContent";

const slots: SessionMenuSlots = {
  item: (key, children, onSelect) => (
    <button key={key} onClick={onSelect}>
      {children}
    </button>
  ),
  separator: (key) => <hr key={key} />,
  submenu: ({ key, trigger, children, onOpenChange }) => (
    <section key={key}>
      <button onClick={() => onOpenChange?.(true)}>{trigger}</button>
      <div>{children as ReactNode}</div>
    </section>
  ),
};

afterEach(cleanup);

describe("Session menu content", () => {
  test("routes pin and every Session color choice", async () => {
    const togglePin = vi.fn();
    const setColor = vi.fn();
    render(
      <SessionMenuContent
        slots={slots}
        focusTagInput={false}
        pinned={false}
        currentColor={undefined}
        currentTags={[]}
        availableProjects={[]}
        displayProjectDir={null}
        currentProjectDir={null}
        onTogglePin={togglePin}
        onSetColor={setColor}
        onSetTags={vi.fn()}
        onMoveToProject={vi.fn()}
        onRemoveFromProject={null}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "sessionMenu.pin" }));
    expect(togglePin).toHaveBeenCalledOnce();
    for (const button of screen.getAllByRole("button", { name: /sessionMenu\.colors\./ })) {
      await userEvent.click(button);
    }
    expect(setColor.mock.calls.map(([color]) => color)).toEqual([
      null,
      "red",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
      "pink",
      "gray",
    ]);
  });

  test("exposes only authorized actions and routes project movement", async () => {
    const rename = vi.fn();
    const share = vi.fn();
    const remove = vi.fn();
    const move = vi.fn();
    render(
      <SessionMenuContent
        slots={slots}
        focusTagInput={false}
        pinned={false}
        currentColor={undefined}
        currentTags={[]}
        availableProjects={["/work/Alpha", "/work/Beta"]}
        displayProjectDir="/work/Alpha"
        currentProjectDir="/work/Alpha"
        onTogglePin={vi.fn()}
        onSetColor={vi.fn()}
        onSetTags={vi.fn()}
        onMoveToProject={move}
        onRemoveFromProject={remove}
        onRename={rename}
        onShare={share}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "sessionMenu.rename" }));
    await userEvent.click(screen.getByRole("button", { name: "sessionMenu.share" }));
    await userEvent.click(screen.getByRole("button", { name: "Beta" }));
    await userEvent.click(screen.getByRole("button", { name: /sessionMenu.removeFromProject/ }));
    expect(rename).toHaveBeenCalledOnce();
    expect(share).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledWith("/work/Beta");
    expect(remove).toHaveBeenCalledOnce();
    expect(screen.queryByText("sessionMenu.deleteSession")).toBeNull();
  });

  test("adds and removes tags but ignores Enter used by an IME", async () => {
    const setTags = vi.fn();
    render(
      <SessionMenuContent
        slots={slots}
        focusTagInput={false}
        pinned
        currentColor={undefined}
        currentTags={["bug"]}
        availableProjects={[]}
        displayProjectDir={null}
        currentProjectDir={null}
        onTogglePin={vi.fn()}
        onSetColor={vi.fn()}
        onSetTags={setTags}
        onMoveToProject={vi.fn()}
        onRemoveFromProject={null}
      />,
    );
    const input = screen.getByPlaceholderText("sessionMenu.addTag");
    await userEvent.type(input, "日本語");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(setTags).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setTags).toHaveBeenCalledWith(["bug", "日本語"]);
    await userEvent.click(screen.getByRole("button", { name: "sessionMenu.removeTag:bug" }));
    expect(setTags).toHaveBeenLastCalledWith([]);
  });
});
