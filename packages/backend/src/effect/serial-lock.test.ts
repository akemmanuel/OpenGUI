import { describe, expect, test } from "vite-plus/test";
import { KeyedSerialLock, SerialLock } from "./serial-lock.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("SerialLock", () => {
  test("runs tasks one at a time in arrival order", async () => {
    const lock = new SerialLock();
    const events: string[] = [];
    const task = (name: string) => async () => {
      events.push(`${name}:start`);
      await tick();
      events.push(`${name}:end`);
      return name;
    };
    expect(
      await Promise.all([lock.run(task("a")), lock.run(task("b")), lock.run(task("c"))]),
    ).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  test("a failing task rejects with its own error and releases the lock", async () => {
    const lock = new SerialLock();
    class Boom extends Error {}
    await expect(lock.run(async () => Promise.reject(new Boom("boom")))).rejects.toBeInstanceOf(
      Boom,
    );
    expect(await lock.run(async () => "next")).toBe("next");
  });
});

describe("KeyedSerialLock", () => {
  test("serializes per key and runs different keys concurrently", async () => {
    const lock = new KeyedSerialLock();
    const events: string[] = [];
    const task = (name: string) => async () => {
      events.push(`${name}:start`);
      await tick();
      events.push(`${name}:end`);
    };
    await Promise.all([
      lock.run("x", task("x1")),
      lock.run("y", task("y1")),
      lock.run("x", task("x2")),
    ]);
    expect(events.indexOf("y1:start")).toBeLessThan(events.indexOf("x1:end"));
    expect(events.indexOf("x2:start")).toBeGreaterThan(events.indexOf("x1:end"));
  });

  test("idle waits for queued work on that key", async () => {
    const lock = new KeyedSerialLock();
    let done = false;
    void lock.run("x", async () => {
      await tick();
      done = true;
    });
    await lock.idle("x");
    expect(done).toBe(true);
  });
});
