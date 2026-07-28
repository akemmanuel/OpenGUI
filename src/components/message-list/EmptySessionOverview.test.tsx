// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { EmptySessionOverview } from "./EmptySessionOverview";

const listSkills = vi.fn();
const ensureSessionSkills = vi.fn();
const toggleSessionSkill = vi.fn();
const sessionState = vi.hoisted(() => ({
  enabledSkillNames: [] as string[],
  skillsLocked: false,
}));

vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({ listSkills, ensureSessionSkills, toggleSessionSkill }),
  useSessionState: () => sessionState,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
  listSkills.mockReset();
  ensureSessionSkills.mockReset();
  toggleSessionSkill.mockReset();
  sessionState.enabledSkillNames = [];
  sessionState.skillsLocked = false;
});

describe("EmptySessionOverview", () => {
  test("initializes defaults and toggles skills before lock", async () => {
    listSkills.mockResolvedValue([
      {
        name: "code-review",
        description: "Review pull requests carefully.",
        source: "project",
        manual: false,
      },
      {
        name: "impeccable",
        description: "Design frontend interfaces.",
        source: "host",
        manual: true,
      },
    ]);
    sessionState.enabledSkillNames = ["code-review"];

    render(<EmptySessionOverview directory="/work/demo-site" />);

    await waitFor(() => {
      expect(screen.getByText("impeccable")).toBeTruthy();
    });
    await waitFor(() => expect(ensureSessionSkills).toHaveBeenCalled());
    expect(screen.getByLabelText("emptySession.skillsHeading").textContent).toBe(
      "code-review, impeccable",
    );

    fireEvent.click(screen.getByRole("button", { name: "impeccable" }));
    expect(toggleSessionSkill).toHaveBeenCalledWith(
      "impeccable",
      expect.arrayContaining([expect.objectContaining({ name: "impeccable" })]),
    );
  });

  test("locks skill buttons after the session has started", async () => {
    listSkills.mockResolvedValue([
      {
        name: "code-review",
        description: "Review pull requests carefully.",
        source: "project",
        manual: false,
      },
    ]);
    sessionState.enabledSkillNames = ["code-review"];
    sessionState.skillsLocked = true;

    render(<EmptySessionOverview directory="/work/demo-site" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "code-review" })).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "code-review" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "code-review" }));
    expect(toggleSessionSkill).not.toHaveBeenCalled();
  });
});
