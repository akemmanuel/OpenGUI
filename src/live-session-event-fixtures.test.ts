import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { HarnessEvent } from "@/agents/backend";
import { harnessEventToAdapterObservations } from "../packages/runtime/src/live-session-events/live-session-event-compat.ts";
import { LiveSessionEventBus } from "@opengui/runtime";
import { LiveSessionProjection } from "../packages/runtime/src/live-session-events/live-session-projection.ts";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/runtime/src/live-session-events/__fixtures__",
);

type FixtureFile = {
  description?: string;
  harnessEvents: HarnessEvent[];
  expectEventTypes: string[];
  expectFinalText?: string;
};

function loadFixtures(): Array<{ name: string; fixture: FixtureFile }> {
  return readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      fixture: JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as FixtureFile,
    }));
}

const directory = "/tmp/project";
const harnessId = "pi" as const;

describe("live session event golden fixtures", () => {
  for (const { name, fixture } of loadFixtures()) {
    test(name, () => {
      const bus = new LiveSessionEventBus();
      const projection = new LiveSessionProjection();
      const types: string[] = [];

      for (const event of fixture.harnessEvents) {
        const observations = harnessEventToAdapterObservations({ directory, harnessId, event });
        for (const live of bus.publish(observations)) {
          types.push(live.type);
          projection.apply(live);
        }
      }

      expect(types).toEqual(fixture.expectEventTypes);

      if (fixture.expectFinalText) {
        const messages = projection.getMessages();
        const text = messages.flatMap((m) => m.parts).find((p) => p.type === "text")?.text;
        expect(text).toBe(fixture.expectFinalText);
      }
    });
  }
});
