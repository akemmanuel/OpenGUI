// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { ActionsContext, type ActionsContextValue } from "@/hooks/agent-contexts";
import { AssistantMessageError, parseRetryAfter } from "./AssistantMessageError";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    i18n: { language: "en-GB" },
  }),
}));

describe("AssistantMessageError", () => {
  afterEach(() => cleanup());

  test("renders raw provider errors as before", () => {
    render(
      <AssistantMessageError
        error={{ name: "Model request failed", data: { message: "Model provider is unavailable" } }}
      />,
    );
    expect(screen.getByText("Model provider is unavailable")).toBeDefined();
  });

  test("localizes compaction recovery-required errors with retry guidance", () => {
    render(
      <AssistantMessageError
        error={{
          name: "Model request failed",
          data: {
            message: "Compaction needs attention before continuing",
            code: "compactionRecoveryRequired",
          },
        }}
      />,
    );
    expect(screen.getByText("messageError.compactionRecoveryTitle")).toBeDefined();
    expect(screen.getByText("messageError.compactionRecoveryDetail")).toBeDefined();
    expect(screen.queryByText("Compaction needs attention before continuing")).toBeNull();
  });

  test("survives rerender transitions between absent and recovery errors", () => {
    const recovery = {
      name: "Model request failed",
      data: {
        message: "Compaction needs attention before continuing",
        code: "compactionRecoveryRequired",
      },
    };
    const { rerender } = render(<AssistantMessageError error={undefined} />);
    expect(screen.queryByText("messageError.compactionRecoveryTitle")).toBeNull();
    rerender(<AssistantMessageError error={recovery} />);
    expect(screen.getByText("messageError.compactionRecoveryTitle")).toBeDefined();
    rerender(<AssistantMessageError error={undefined} />);
    expect(screen.queryByText("messageError.compactionRecoveryTitle")).toBeNull();
  });

  test("offers compacting from the recovery card and only there", async () => {
    const summarizeSession = vi.fn(async () => {});
    const actions = { summarizeSession } as unknown as ActionsContextValue;
    const recovery = {
      name: "Model request failed",
      data: { message: "Compaction needs attention", code: "compactionRecoveryRequired" },
    };
    const { rerender } = render(
      <ActionsContext.Provider value={actions}>
        <AssistantMessageError error={recovery} />
      </ActionsContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "messageError.compactNow" }));
    await waitFor(() => expect(summarizeSession).toHaveBeenCalledTimes(1));

    rerender(
      <ActionsContext.Provider value={actions}>
        <AssistantMessageError
          error={{ name: "Model request failed", data: { message: "Provider down" } }}
        />
      </ActionsContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "messageError.compactNow" })).toBeNull();
  });

  test("explains usage limits with the reset time and a model switch", () => {
    const failedAt = Date.UTC(2026, 9, 13, 10, 0);
    render(
      <AssistantMessageError
        error={{
          name: "Model request failed",
          data: {
            message:
              "Model provider rate limit reached: You have hit your ChatGPT usage limit (plus plan). Try again in ~148 min.",
            providerCode: "rate_limit",
            failedAt,
          },
        }}
      />,
    );
    expect(screen.getByText("messageError.rateLimitTitle")).toBeDefined();
    expect(
      screen.getByText(/messageError\.rateLimitRetryAt .*messageError\.switchModelHint/),
    ).toBeDefined();
  });

  test("explains provider outages after automatic retries", () => {
    render(
      <AssistantMessageError
        error={{
          name: "Model request failed",
          data: { message: "Model provider is unavailable", providerCode: "provider_unavailable" },
        }}
      />,
    );
    expect(screen.getByText("messageError.unavailableTitle")).toBeDefined();
    expect(screen.getByText("messageError.unavailableDetail")).toBeDefined();
  });
});

describe("parseRetryAfter", () => {
  const from = Date.UTC(2026, 9, 13, 10, 0);
  test.each([
    ["Try again in ~148 min.", from + 148 * 60_000],
    ["try again in 2 hours", from + 2 * 3_600_000],
    ["Please try again in 30s", from + 30_000],
  ])("parses %s", (message, expected) => {
    expect(parseRetryAfter(message, from)?.getTime()).toBe(expected);
  });

  test("ignores messages without a reset hint or failure time", () => {
    expect(parseRetryAfter("The usage limit has been reached", from)).toBeUndefined();
    expect(parseRetryAfter("Try again in 5 min", undefined)).toBeUndefined();
  });
});
