import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  distanceFromBottom,
  isAtTop,
  isNearBottom,
  shouldLoadOlderMessages,
} from "./VirtualMessageScroller";

function scrollElement(input: { scrollHeight: number; scrollTop: number; clientHeight: number }) {
  return input as HTMLElement;
}

describe("VirtualMessageScroller scroll position helpers", () => {
  test("does not treat top of an overflowing chat as pinned to bottom", () => {
    const element = scrollElement({ scrollHeight: 5000, scrollTop: 0, clientHeight: 800 });

    expect(isAtTop(element)).toBe(true);
    expect(distanceFromBottom(element)).toBe(4200);
    expect(isNearBottom(element)).toBe(false);
  });

  test("treats real bottom as pinned to bottom", () => {
    const element = scrollElement({ scrollHeight: 5000, scrollTop: 4200, clientHeight: 800 });

    expect(isAtTop(element)).toBe(false);
    expect(distanceFromBottom(element)).toBe(0);
    expect(isNearBottom(element)).toBe(true);
  });

  test("keeps short non-scrollable chats pinned to bottom", () => {
    const element = scrollElement({ scrollHeight: 700, scrollTop: 0, clientHeight: 800 });

    expect(isAtTop(element)).toBe(true);
    expect(distanceFromBottom(element)).toBe(0);
    expect(isNearBottom(element)).toBe(true);
  });
});

describe("shouldLoadOlderMessages", () => {
  test("requests older history near the top of a paged transcript", () => {
    expect(
      shouldLoadOlderMessages({
        firstIndex: 0,
        hasOlder: true,
        isLoadingOlder: false,
        loadInFlight: false,
      }),
    ).toBe(true);
  });

  test("does not request older history while away from top or already loading", () => {
    expect(
      shouldLoadOlderMessages({
        firstIndex: 12,
        hasOlder: true,
        isLoadingOlder: false,
        loadInFlight: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadOlderMessages({
        firstIndex: 0,
        hasOlder: true,
        isLoadingOlder: true,
        loadInFlight: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadOlderMessages({
        firstIndex: 0,
        hasOlder: true,
        isLoadingOlder: false,
        loadInFlight: true,
      }),
    ).toBe(false);
  });
});
