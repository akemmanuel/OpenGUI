// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { InteractionRequestsView } from "./InteractionRequestsView";

afterEach(cleanup);

describe("interaction request panels", () => {
  test("returns each explicit permission decision", async () => {
    const respond = vi.fn();
    render(
      <InteractionRequestsView
        permission={{ id: "p1", permission: "shell", patterns: ["git *"] } as never}
        question={null}
        onRespondPermission={respond}
        onReplyQuestion={vi.fn()}
        onRejectQuestion={vi.fn()}
      />,
    );
    expect(screen.getByText("git *")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "permissionPanel.allowOnce" }));
    await userEvent.click(screen.getByRole("button", { name: "permissionPanel.alwaysAllow" }));
    await userEvent.click(screen.getByRole("button", { name: "permissionPanel.reject" }));
    expect(respond.mock.calls.map(([value]) => value)).toEqual(["once", "always", "reject"]);
  });

  test("requires every question and combines multiple choice with a custom answer", async () => {
    const reply = vi.fn();
    render(
      <InteractionRequestsView
        permission={null}
        question={
          {
            id: "q1",
            questions: [
              {
                header: "Scope",
                question: "Which areas?",
                multiple: true,
                options: [
                  { label: "UI", description: "Frontend" },
                  { label: "API", description: "Backend" },
                ],
              },
              {
                header: "Deploy",
                question: "Where?",
                custom: false,
                options: [{ label: "Staging", description: "Safe" }],
              },
            ],
          } as never
        }
        onRespondPermission={vi.fn()}
        onReplyQuestion={reply}
        onRejectQuestion={vi.fn()}
      />,
    );
    const submit = screen.getByRole("button", { name: "questionPanel.submit" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "UI" }));
    await userEvent.type(
      screen.getByPlaceholderText("questionPanel.customAnswerPlaceholder"),
      "Docs",
    );
    expect(submit.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Staging" }));
    await userEvent.click(submit);
    expect(reply).toHaveBeenCalledWith([["UI", "Docs"], ["Staging"]]);
  });

  test("does not submit a custom answer while IME composition is being confirmed", async () => {
    const reply = vi.fn();
    render(
      <InteractionRequestsView
        permission={null}
        question={
          {
            id: "q1",
            questions: [{ header: "Name", question: "Name it", options: [], custom: true }],
          } as never
        }
        onRespondPermission={vi.fn()}
        onReplyQuestion={reply}
        onRejectQuestion={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText("questionPanel.customAnswerPlaceholder");
    await userEvent.type(input, "東京");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(reply).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(reply).toHaveBeenCalledWith([["東京"]]);
  });
});
