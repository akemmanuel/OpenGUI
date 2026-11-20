// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

const resize = vi.hoisted(() => ({
  callback: null as ResizeObserverCallback | null,
  disconnect: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { TranscriptViewport } from "./transcript-viewport";

function setGeometry(
  element: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
    scrollTop: {
      configurable: true,
      get: () => geometry.scrollTop,
      set: (value) => {
        geometry.scrollTop = value;
      },
    },
  });
}

describe("TranscriptViewport scroll anchoring", () => {
  beforeEach(() => {
    resize.disconnect.mockReset();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize.callback = callback;
        }
        observe() {}
        disconnect() {
          resize.disconnect();
        }
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("paints its own theme background instead of exposing a compositor backing layer", () => {
    render(
      <TranscriptViewport
        sessionId="s1"
        contentKey="1"
        pinWhenNearBottom
        isLoadingOlder={false}
        onLoadOlder={async () => true}
        showLoadOlderRow={false}
      >
        <div>message</div>
      </TranscriptViewport>,
    );

    const viewport = screen.getByText("message").parentElement!.parentElement!;
    expect(viewport.className.split(/\s+/)).toContain("bg-background");
  });

  test("keeps a prepended page anchored and retries a failed older-page load", async () => {
    const loadOlder = vi.fn().mockResolvedValue(false);
    const view = render(
      <TranscriptViewport
        sessionId="s1"
        contentKey="1"
        pinWhenNearBottom
        isLoadingOlder={false}
        loadOlderError="failed"
        onLoadOlder={loadOlder}
        showLoadOlderRow
      >
        <div>newest</div>
      </TranscriptViewport>,
    );
    const viewport = screen.getByText("newest").parentElement!.parentElement!;
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 200 };
    setGeometry(viewport, geometry);
    await userEvent.click(screen.getByRole("button", { name: "messageList.loadOlder" }));
    expect(loadOlder).toHaveBeenCalledOnce();
    geometry.scrollHeight = 1300;
    view.rerender(
      <TranscriptViewport
        sessionId="s1"
        contentKey="2"
        pinWhenNearBottom
        isLoadingOlder={false}
        loadOlderError={null}
        onLoadOlder={loadOlder}
        showLoadOlderRow
      >
        <div>older</div>
        <div>newest</div>
      </TranscriptViewport>,
    );
    expect(geometry.scrollTop).toBe(500);
  });

  test("pins streaming and resize growth only while the user remains near the bottom", () => {
    const view = render(
      <TranscriptViewport
        sessionId="s1"
        contentKey="1"
        pinWhenNearBottom
        isLoadingOlder={false}
        onLoadOlder={async () => true}
        showLoadOlderRow={false}
      >
        <div>message</div>
      </TranscriptViewport>,
    );
    const viewport = screen.getByText("message").parentElement!.parentElement!;
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 595 };
    setGeometry(viewport, geometry);
    fireEvent.scroll(viewport);
    geometry.scrollHeight = 1100;
    view.rerender(
      <TranscriptViewport
        sessionId="s1"
        contentKey="2"
        pinWhenNearBottom
        isLoadingOlder={false}
        onLoadOlder={async () => true}
        showLoadOlderRow={false}
      >
        <div>streamed</div>
      </TranscriptViewport>,
    );
    expect(geometry.scrollTop).toBe(700);
    fireEvent.wheel(viewport, { deltaY: -20 });
    geometry.scrollHeight = 1200;
    resize.callback?.([], {} as ResizeObserver);
    expect(geometry.scrollTop).toBe(700);
    view.unmount();
    expect(resize.disconnect).toHaveBeenCalledOnce();
  });

  test("keeps a pinned turn at the bottom for its final busy-to-idle update", () => {
    const view = render(
      <TranscriptViewport
        sessionId="s1"
        contentKey="busy"
        pinWhenNearBottom
        isLoadingOlder={false}
        onLoadOlder={async () => true}
        showLoadOlderRow={false}
      >
        <div>streaming</div>
      </TranscriptViewport>,
    );
    const viewport = screen.getByText("streaming").parentElement!.parentElement!;
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 595 };
    setGeometry(viewport, geometry);
    fireEvent.scroll(viewport);

    geometry.scrollHeight = 1100;
    view.rerender(
      <TranscriptViewport
        sessionId="s1"
        contentKey="complete"
        pinWhenNearBottom={false}
        isLoadingOlder={false}
        onLoadOlder={async () => true}
        showLoadOlderRow={false}
      >
        <div>complete</div>
      </TranscriptViewport>,
    );

    expect(geometry.scrollTop).toBe(700);
  });

  test("does not pin the final busy-to-idle update after the user scrolls up", () => {
    const view = render(
      <TranscriptViewport
        sessionId="s1"
        contentKey="busy"
        pinWhenNearBottom
        isLoadingOlder={false}
        onLoadOlder={async () => true}
        showLoadOlderRow={false}
      >
        <div>streaming</div>
      </TranscriptViewport>,
    );
    const viewport = screen.getByText("streaming").parentElement!.parentElement!;
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 300 };
    setGeometry(viewport, geometry);
    fireEvent.wheel(viewport, { deltaY: -20 });

    geometry.scrollHeight = 1100;
    view.rerender(
      <TranscriptViewport
        sessionId="s1"
        contentKey="complete"
        pinWhenNearBottom={false}
        isLoadingOlder={false}
        onLoadOlder={async () => true}
        showLoadOlderRow={false}
      >
        <div>complete</div>
      </TranscriptViewport>,
    );

    expect(geometry.scrollTop).toBe(300);
  });

  test("resets the pin when switching Sessions", () => {
    const view = render(
      <TranscriptViewport
        sessionId="s1"
        contentKey="1"
        pinWhenNearBottom
        isLoadingOlder={false}
        onLoadOlder={async () => true}
        showLoadOlderRow={false}
      >
        <div>one</div>
      </TranscriptViewport>,
    );
    const viewport = screen.getByText("one").parentElement!.parentElement!;
    const geometry = { scrollHeight: 900, clientHeight: 300, scrollTop: 10 };
    setGeometry(viewport, geometry);
    fireEvent.wheel(viewport, { deltaY: -10 });
    view.rerender(
      <TranscriptViewport
        sessionId="s2"
        contentKey="1"
        pinWhenNearBottom
        isLoadingOlder={false}
        onLoadOlder={async () => true}
        showLoadOlderRow={false}
      >
        <div>two</div>
      </TranscriptViewport>,
    );
    const nextViewport = screen.getByText("two").parentElement!.parentElement!;
    setGeometry(nextViewport, geometry);
    resize.callback?.([], {} as ResizeObserver);
    expect(geometry.scrollTop).toBe(600);
  });
});
