// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { useSessionSkills } from "./use-session-skills";

const fixture = vi.hoisted(() => ({
  listSkills: vi.fn(),
}));

vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({ listSkills: fixture.listSkills }),
}));

function Probe({
  directory,
  onState,
}: {
  directory: string | null;
  onState: (state: ReturnType<typeof useSessionSkills>) => void;
}) {
  const state = useSessionSkills(directory);
  onState(state);
  return null;
}

afterEach(() => {
  cleanup();
  fixture.listSkills.mockReset();
});

describe("useSessionSkills", () => {
  test("does not cancel an in-flight fetch when listSkills identity changes", async () => {
    let resolveSkills: (
      value: Array<{ name: string; description: string; source: "host" }>,
    ) => void = () => undefined;

    const firstListSkills = vi.fn(
      () =>
        new Promise<Array<{ name: string; description: string; source: "host" }>>((resolve) => {
          resolveSkills = resolve;
        }),
    );
    fixture.listSkills = firstListSkills;

    const states: Array<ReturnType<typeof useSessionSkills>> = [];
    const { rerender } = render(
      <Probe directory="/project" onState={(state) => states.push(state)} />,
    );

    expect(firstListSkills).toHaveBeenCalledTimes(1);

    // Simulate HostProvider rebuilding the actions object on an unrelated update.
    const secondListSkills = vi.fn(async () => [
      { name: "should-not-run", description: "x", source: "host" as const },
    ]);
    fixture.listSkills = secondListSkills;
    rerender(<Probe directory="/project" onState={(state) => states.push(state)} />);

    expect(secondListSkills).not.toHaveBeenCalled();
    expect(firstListSkills).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSkills([{ name: "demo", description: "Demo skill", source: "host" }]);
    });

    await waitFor(() => {
      expect(states.at(-1)).toEqual({
        status: "ready",
        skills: [{ name: "demo", description: "Demo skill", source: "host" }],
      });
    });
  });
});
