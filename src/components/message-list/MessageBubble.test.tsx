// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ toggle: vi.fn(), fork: vi.fn(), revert: vi.fn() }));
vi.mock("@/features/identity/ActorAttribution", () => ({
  ActorAttribution: () => <span>actor</span>,
}));
vi.mock("@/components/ImageMentionPreview", () => ({
  ImageMentionThumbnails: ({ images, onOpen }: any) => (
    <button onClick={() => onOpen(images[0])}>images:{images.length}</button>
  ),
  ImageMentionLightbox: ({ image, onClose }: any) =>
    image ? <button onClick={onClose}>lightbox:{image.filename}</button> : null,
}));
vi.mock("./MessageBubbleActions", () => ({
  MessageBubbleActions: ({ onFork, onRevert }: any) => (
    <div>
      <button onClick={onFork}>fork</button>
      <button onClick={onRevert}>revert</button>
    </div>
  ),
}));
vi.mock("./CollapsibleUserMessageBody", () => ({
  CollapsibleUserMessageBody: ({ shouldCollapse, expanded, onToggleExpanded, messageId }: any) => (
    <button onClick={() => onToggleExpanded(messageId)}>
      user:{String(shouldCollapse)}:{String(expanded)}
    </button>
  ),
}));
vi.mock("./MessagePartsStack", () => ({
  MessagePartsStack: ({ isAssistantTurnActive }: any) => (
    <span>assistant:{String(isAssistantTurnActive)}</span>
  ),
}));
vi.mock("./AssistantMessageError", () => ({ AssistantMessageError: () => <span>error</span> }));
vi.mock("./AssistantTurnFooter", () => ({ AssistantTurnFooter: () => <span>footer</span> }));
vi.mock("./ContextCompactedBanner", () => ({
  ContextCompactedBanner: () => <span>compacted</span>,
}));

import { USER_MSG_COLLAPSE_CHARS } from "@/lib/constants";
import { MessageBubble } from "./MessageBubble";

afterEach(cleanup);

describe("MessageBubble", () => {
  test("renders a large user message, unique image mentions, and user actions without providers", async () => {
    const text = `${"x".repeat(USER_MSG_COLLAPSE_CHARS + 1)}\n@/tmp/a.png @/tmp/a.png`;
    render(
      <MessageBubble
        entry={
          {
            info: { id: "m1", role: "user", sessionID: "s", time: { created: 1 } },
            parts: [{ id: "p1", type: "text", text, sessionID: "s", messageID: "m1" }],
          } as never
        }
        onFork={fixture.fork}
        onRevert={fixture.revert}
        onToggleUserMessage={fixture.toggle}
        imageBaseDirectory="/tmp"
        attachmentBaseUrl="https://host.example"
      />,
    );
    expect(screen.getByText("images:1")).toBeTruthy();
    await userEvent.click(screen.getByText("user:true:false"));
    await userEvent.click(screen.getByText("fork"));
    await userEvent.click(screen.getByText("revert"));
    expect(fixture.toggle).toHaveBeenCalledWith("m1");
    expect(fixture.fork).toHaveBeenCalled();
    expect(fixture.revert).toHaveBeenCalled();
    await userEvent.click(screen.getByText("images:1"));
    expect(screen.getByText("lightbox:a.png")).toBeTruthy();
  });

  test("renders compacted, completed assistant turns with error and footer", () => {
    render(
      <MessageBubble
        entry={
          {
            info: {
              id: "m2",
              role: "assistant",
              sessionID: "s",
              summary: true,
              time: { created: 1, completed: 2 },
              error: { name: "Failure" },
            },
            parts: [],
          } as never
        }
        turnFooter={{ durationMs: 1 } as never}
        imageBaseDirectory={null}
        attachmentBaseUrl={null}
      />,
    );
    expect(screen.getByText("compacted")).toBeTruthy();
    expect(screen.getByText("assistant:false")).toBeTruthy();
    expect(screen.getByText("error")).toBeTruthy();
    expect(screen.getByText("footer")).toBeTruthy();
  });
});
