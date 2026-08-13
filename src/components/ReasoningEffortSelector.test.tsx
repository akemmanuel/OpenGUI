// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  efforts: undefined as string[] | undefined,
  setReasoningEffort: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({ setReasoningEffort: fixture.setReasoningEffort }),
  useModelState: () => ({
    selectedModel: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
    reasoningEffort: "high",
    providers: [
      {
        id: "deepseek",
        models: {
          "deepseek-v4-pro": {
            capabilities: { reasoning: true },
            reasoningEfforts: fixture.efforts,
          },
        },
      },
    ],
  }),
}));

import { ReasoningEffortSelector } from "./ReasoningEffortSelector";

afterEach(() => {
  cleanup();
  fixture.efforts = undefined;
});

describe("ReasoningEffortSelector", () => {
  test("does not invent a full effort menu when capabilities are unresolved", () => {
    render(<ReasoningEffortSelector />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("renders only resolved model efforts", async () => {
    fixture.efforts = ["none", "high", "max"];
    render(<ReasoningEffortSelector />);

    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("reasoningEffort.levels.none")).toBeTruthy();
    expect(screen.getAllByText("reasoningEffort.levels.high").length).toBeGreaterThan(0);
    expect(screen.getByText("reasoningEffort.levels.max")).toBeTruthy();
    expect(screen.queryByText("reasoningEffort.levels.ultra")).toBeNull();
  });
});
