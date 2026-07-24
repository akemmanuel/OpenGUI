// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock("./identity-client", () => ({
  createIdentityClient: () => ({ resolveSessionViewLink: fixture.resolve }),
}));
vi.mock("@/components/MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { tool?: string }) => (values?.tool ? `${key}:${values.tool}` : key),
  }),
}));

import { readViewLinkToken, ViewLinkScreen } from "./ViewLinkScreen";

const snapshot = (title: string, entries: Array<Record<string, unknown>> = []) => ({
  id: `session-${title}`,
  title,
  entries,
});

describe("ViewLinkScreen", () => {
  beforeEach(() => fixture.resolve.mockReset());
  afterEach(cleanup);

  test("reads only a non-empty view token", () => {
    expect(readViewLinkToken("https://app.test/?view=%20token-1%20")).toBe("token-1");
    expect(readViewLinkToken("https://app.test/?view=%20%20")).toBeNull();
    expect(readViewLinkToken("https://app.test/")).toBeNull();
  });

  test("renders loading, empty, and every public transcript item without exposing ignored entries", async () => {
    let finish!: (value: unknown) => void;
    fixture.resolve.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<ViewLinkScreen token="valid" />);
    expect(screen.getByRole("status")).toBeTruthy();
    finish({
      session: snapshot("Shared plan", [
        {
          id: "u",
          kind: "user_message",
          payload: { text: "Question", actor: { displayName: "Ada" } },
        },
        { id: "a", kind: "assistant_message", payload: { text: "Answer" } },
        { id: "t", kind: "tool_call", payload: { name: "read" } },
        { id: "hidden", kind: "run_started", payload: { text: "secret metadata" } },
      ]),
    });
    expect(await screen.findByRole("heading", { name: "Shared plan" })).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("Question")).toBeTruthy();
    expect(screen.getByText("Answer")).toBeTruthy();
    expect(screen.getByText("viewLink.usedTool:read")).toBeTruthy();
    expect(screen.queryByText("secret metadata")).toBeNull();
  });

  test("retries a failed link and ignores stale results during rapid token changes and unmount", async () => {
    let staleResolve!: (value: unknown) => void;
    fixture.resolve
      .mockReturnValueOnce(
        new Promise((resolve) => {
          staleResolve = resolve;
        }),
      )
      .mockRejectedValueOnce(new Error("expired"))
      .mockResolvedValueOnce({ session: snapshot("Recovered") });
    const view = render(<ViewLinkScreen token="old" />);
    view.rerender(<ViewLinkScreen token="new" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(await screen.findByRole("heading", { name: "Recovered" })).toBeTruthy();
    staleResolve({ session: snapshot("Stale") });
    await waitFor(() => expect(screen.queryByText("Stale")).toBeNull());
    view.unmount();
  });
});
