// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { AssistantMessageError } from "./AssistantMessageError";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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
});
