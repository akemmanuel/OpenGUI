// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { STORAGE_KEYS } from "@/lib/constants";
import { polyfillLocalStorage } from "@/lib/__tests__/setup";

polyfillLocalStorage();

const fixture = vi.hoisted(() => ({
  setModel: vi.fn().mockResolvedValue(undefined),
  selectedModel: { providerID: "alpha", modelID: "a1" } as null | {
    providerID: string;
    modelID: string;
  },
  providers: [
    {
      id: "alpha",
      name: "Alpha AI",
      models: {
        a1: { name: "Alpha One", capabilities: { reasoning: false } },
        a2: { name: "Alpha Two", capabilities: { reasoning: true } },
      },
    },
    {
      id: "beta",
      name: "Beta Labs",
      models: { b1: { name: "Beta One", capabilities: { reasoning: false } } },
    },
  ],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { query?: string }) =>
      values?.query ? `${key}:${values.query}` : key,
  }),
}));
vi.mock("@/components/provider-icons", () => ({ ProviderIcon: () => <span aria-hidden="true" /> }));
vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({ setModel: fixture.setModel }),
  useModelState: () => ({
    providers: fixture.providers,
    selectedModel: fixture.selectedModel,
  }),
}));
vi.mock("@/shell/useRegisterMobileBackHandler", () => ({
  useRegisterMobileBackHandler: vi.fn(),
}));

import { ModelSelector } from "./ModelSelector";

describe("ModelSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    fixture.selectedModel = { providerID: "alpha", modelID: "a1" };
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    if (!globalThis.CSS) vi.stubGlobal("CSS", {});
    Object.defineProperty(globalThis.CSS, "escape", {
      configurable: true,
      value: (value: string) => value,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });
  afterEach(cleanup);

  test("searches across providers and chooses the keyboard-active model", async () => {
    render(
      <>
        <textarea data-slot="prompt-box-textarea" aria-label="prompt" />
        <ModelSelector />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Alpha One/ }));
    const search = await screen.findByPlaceholderText("modelSelector.searchPlaceholder");
    await userEvent.type(search, "beta");
    expect(screen.getByRole("button", { name: /Beta One/ })).toBeTruthy();
    fireEvent.keyDown(search, { key: "Enter" });

    expect(fixture.setModel).toHaveBeenCalledWith({ providerID: "beta", modelID: "b1" });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.RECENT_MODELS) ?? "[]")).toEqual([
      "beta/b1",
    ]);
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("modelSelector.searchPlaceholder")).toBeNull(),
    );
  });

  test("shows an honest empty result and closes without selecting on Escape", async () => {
    render(<ModelSelector />);
    await userEvent.click(screen.getByRole("button", { name: /Alpha One/ }));
    const search = await screen.findByPlaceholderText("modelSelector.searchPlaceholder");
    await userEvent.type(search, "missing model");
    expect(screen.getByText("modelSelector.noModelsMatch:missing model")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(fixture.setModel).not.toHaveBeenCalled();
  });

  test("opens from the global keyboard-chord event", async () => {
    render(<ModelSelector />);
    fireEvent(window, new CustomEvent("open-model-selector"));
    expect(await screen.findByPlaceholderText("modelSelector.searchPlaceholder")).toBeTruthy();
  });
});
