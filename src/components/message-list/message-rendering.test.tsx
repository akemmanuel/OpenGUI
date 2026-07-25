// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const browser = vi.hoisted(() => ({ copy: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/browser", () => ({ copyTextToClipboard: browser.copy }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-agent-state", () => ({
  useWorkspaceState: () => ({ workspaceServerUrl: "https://host.example" }),
}));
vi.mock("@/components/MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

import { AssistantMessageError } from "./AssistantMessageError";
import { FilePartView } from "./FilePartView";
import { MessagePartsStack } from "./MessagePartsStack";
import { ToolCallOutputView } from "./tools/ToolCallOutputView";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("transcript message rendering", () => {
  test("renders remote images with useful alternate text and ordinary file attachments as text", () => {
    const { rerender } = render(
      <FilePartView
        part={
          {
            id: "f1",
            type: "file",
            sessionID: "s",
            messageID: "m",
            mime: "image/png",
            filename: "chart.png",
            url: "/api/files/chart.png",
          } as never
        }
      />,
    );
    const image = screen.getByRole("img", { name: "chart.png" }) as HTMLImageElement;
    expect(image.src).toContain("https://host.example/api/fs/file?path=%2Fapi%2Ffiles%2Fchart.png");
    rerender(
      <FilePartView
        part={
          {
            id: "f2",
            type: "file",
            sessionID: "s",
            messageID: "m",
            mime: "application/pdf",
            filename: "brief.pdf",
            url: "/api/files/brief.pdf",
          } as never
        }
      />,
    );
    expect(screen.getByText("brief.pdf")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("expands and copies complete tool errors without hiding the concise summary", async () => {
    const message = "Provider failed: quota exceeded\nrequest id abc";
    render(<AssistantMessageError error={{ name: "ProviderError", data: { message } } as never} />);
    expect(screen.getByText("Provider failed")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "messageError.showDetails" }));
    expect(document.querySelector("pre")?.textContent).toBe(message);
    await userEvent.click(screen.getByRole("button", { name: "messageError.copy" }));
    expect(browser.copy).toHaveBeenCalledWith(message);
  });

  test("keeps completed reasoning inside activity after the response starts", () => {
    const parts = [
      {
        id: "reasoning-1",
        type: "reasoning" as const,
        text: "First thought",
        time: { start: 1 },
      },
      {
        id: "tool-1",
        type: "tool" as const,
        tool: "read",
        state: { status: "completed", input: {}, output: "done" },
      },
      {
        id: "reasoning-2",
        type: "reasoning" as const,
        text: "Second thought",
        time: { start: 2 },
      },
      { id: "response-1", type: "text" as const, text: "Final response" },
    ];
    const { rerender } = render(<MessagePartsStack parts={parts} isAssistantTurnActive />);

    expect(screen.queryByText("reasoning.thinking")).toBeNull();
    expect(document.querySelector("summary")).toBeTruthy();
    rerender(
      <MessagePartsStack
        parts={parts}
        isAssistantTurnActive
        expandedToolCalls={new Set(["tool-group:reasoning-1"])}
      />,
    );
    expect(screen.getAllByText("reasoning.thinking")).toHaveLength(2);
    expect(screen.queryByText("reasoning.thinkingRunning")).toBeNull();
  });

  test("renders mixed tool output and exposes the lossless raw output", async () => {
    render(
      <ToolCallOutputView
        blocks={
          [
            { type: "text", text: "plain result", format: "text" },
            {
              type: "images",
              images: [
                { url: "image.png", src: "data:image/png;base64,AA", filename: "result.png" },
              ],
            },
            { type: "todos", todos: [{ content: "Verify output", status: "completed" }] },
            {
              type: "task",
              taskInfo: {
                toolCalls: [{ tool: "shell", title: "tests", status: "error" }],
                output: "**Task failed**",
              },
            },
          ] as never
        }
        rawOutput={'{"error":"full detail"}'}
      />,
    );
    expect(screen.getByText("plain result")).toBeTruthy();
    expect(screen.getByRole("img", { name: "result.png" })).toBeTruthy();
    expect(screen.getByText("Verify output")).toBeTruthy();
    expect(screen.getByTestId("markdown").textContent).toBe("**Task failed**");
    await userEvent.click(screen.getByRole("button", { name: "toolOutput.showRaw" }));
    expect(await screen.findByText('{"error":"full detail"}')).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "toolOutput.copyRaw" }));
    expect(browser.copy).toHaveBeenCalledWith('{"error":"full detail"}');
  });
});
