// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { usePromptFiles } from "./use-prompt-files";

class FakeXhr {
  static response: { status: number; body: string; url?: string };
  static last: FakeXhr | null = null;
  upload: {
    onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void;
  } = {};
  onload?: () => void;
  onerror?: () => void;
  status = 0;
  responseText = "";
  responseURL = "";
  headers: Record<string, string> = {};
  url = "";
  form: FormData | null = null;
  open(_method: string, url: string) {
    FakeXhr.last = this;
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  send(form: FormData) {
    this.form = form;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    this.status = FakeXhr.response.status;
    this.responseText = FakeXhr.response.body;
    this.responseURL = FakeXhr.response.url ?? this.url;
    queueMicrotask(() => this.onload?.());
  }
}

describe("uploaded prompt files", () => {
  beforeEach(() => {
    FakeXhr.last = null;
    FakeXhr.response = {
      status: 200,
      body: JSON.stringify({ ok: true, value: ["/project/a b.txt"] }),
    };
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (callback(0), 1));
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { backendUrl: "http://host/", backendToken: "desktop-token" },
    });
  });

  test("uploads files into the Project and inserts returned path mentions at the caret", async () => {
    let value = "Please inspect now";
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setSelectionRange(7, 7);
    const setValue = vi.fn((next: string | ((current: string) => string)) => {
      value = typeof next === "function" ? next(value) : next;
    });
    const { result } = renderHook(() =>
      usePromptFiles({
        disabled: false,
        value,
        setValue,
        serverUrl: null,
        directory: "/project",
        textareaRef: { current: textarea },
      }),
    );

    await act(async () => result.current.appendFiles([new File(["x"], "a b.txt")]));

    expect(setValue).toHaveBeenCalledWith("Please @/project/a b.txt inspect now");
    expect(result.current.uploadProgress).toBe(100);
    expect(result.current.isUploading).toBe(false);
  });

  test("recovers from malformed upload responses and allows a retry", async () => {
    FakeXhr.response = { status: 502, body: "not json", url: "http://host/api/fs/upload" };
    const { result } = renderHook(() =>
      usePromptFiles({
        disabled: false,
        value: "",
        setValue: vi.fn(),
        serverUrl: null,
        directory: "/project",
        textareaRef: { current: null },
      }),
    );
    await act(async () => result.current.appendFiles([new File(["x"], "bad.txt")]));
    await waitFor(() => expect(result.current.isUploading).toBe(false));
    expect(result.current.uploadProgress).toBeNull();

    FakeXhr.response = { status: 200, body: JSON.stringify({ ok: true, value: [] }) };
    await act(async () => result.current.appendFiles([new File(["x"], "retry.txt")]));
    expect(result.current.uploadProgress).toBe(100);
  });

  test("accepts pasted arbitrary file types and reports Host size-limit failures", async () => {
    FakeXhr.response = {
      status: 413,
      body: JSON.stringify({ ok: false, error: "Upload exceeds the 25 MB limit" }),
    };
    const preventDefault = vi.fn();
    const { result } = renderHook(() =>
      usePromptFiles({
        disabled: false,
        value: "",
        setValue: vi.fn(),
        serverUrl: "https://host.example/",
        directory: "/project",
        textareaRef: { current: null },
      }),
    );
    const archive = new File(["binary"], "assets.zip", { type: "application/zip" });
    act(() =>
      result.current.handlePaste({
        preventDefault,
        clipboardData: {
          items: [{ kind: "file", getAsFile: () => archive }],
        },
      } as never),
    );
    await waitFor(() => expect(result.current.isUploading).toBe(false));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(FakeXhr.last?.url).toBe("https://host.example/api/fs/upload");
    expect(FakeXhr.last?.form?.getAll("files")).toHaveLength(1);
    expect(result.current.uploadProgress).toBeNull();
  });

  test("ignores paste and drop while the prompt is read-only", () => {
    const preventPaste = vi.fn();
    const preventDrop = vi.fn();
    const { result } = renderHook(() =>
      usePromptFiles({
        disabled: true,
        value: "",
        setValue: vi.fn(),
        serverUrl: null,
        directory: "/project",
        textareaRef: { current: null },
      }),
    );
    act(() => {
      result.current.handlePaste({
        preventDefault: preventPaste,
        clipboardData: { items: [{ kind: "file", getAsFile: () => new File(["x"], "x.txt") }] },
      } as never);
      result.current.handleDrop({
        preventDefault: preventDrop,
        stopPropagation: vi.fn(),
        dataTransfer: { files: [new File(["x"], "x.txt")] },
      } as never);
    });
    expect(preventPaste).not.toHaveBeenCalled();
    expect(preventDrop).toHaveBeenCalledOnce();
    expect(FakeXhr.last).toBeNull();
  });
});
