import { describe, expect, test } from "vite-plus/test";
import { createHostSliceSetter, reduceHostSlice, type TransportSlice } from "./host-domain-state";

describe("reduceHostSlice", () => {
  const initial: TransportSlice = {
    bootState: "checking-server",
    bootError: null,
    lastError: null,
  };

  test("updates one domain field without replacing its siblings", () => {
    expect(reduceHostSlice(initial, { key: "bootState", value: "ready" })).toEqual({
      ...initial,
      bootState: "ready",
    });
  });

  test("supports functional updates and preserves identity for no-ops", () => {
    const changed = reduceHostSlice(initial, {
      key: "lastError",
      value: (current) => current ?? "offline",
    });
    expect(changed.lastError).toBe("offline");
    expect(reduceHostSlice(changed, { key: "lastError", value: "offline" })).toBe(changed);
  });

  test("returns a stable setter for a field so event subscriptions survive rerenders", () => {
    const dispatch = () => undefined;
    const setter = createHostSliceSetter<TransportSlice>(dispatch);

    expect(setter("bootState")).toBe(setter("bootState"));
    expect(setter("bootState")).not.toBe(setter("lastError"));
  });
});
