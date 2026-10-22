// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import { storageSet } from "@/lib/persistence/storage";
import { STORAGE_KEYS } from "@/lib/constants";
import { applyStoredFontSize, useFontSize } from "./use-font-size";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.style.fontSize = "";
});

test("validates persisted sizes and synchronizes both settings entry points", () => {
  storageSet(STORAGE_KEYS.FONT_SIZE, "99");
  applyStoredFontSize();
  expect(document.documentElement.style.fontSize).toBe("16px");
  const first = renderHook(() => useFontSize());
  const second = renderHook(() => useFontSize());
  act(() => first.result.current[1](18));
  expect(second.result.current[0]).toBe(18);
  expect(document.documentElement.style.fontSize).toBe("18px");
  act(() => second.result.current[1](0));
  expect(first.result.current[0]).toBe(18);
});
