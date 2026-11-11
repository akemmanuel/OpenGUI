// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { EmptySessionOverview } from "./EmptySessionOverview";

const listSkills = vi.fn();
const ensureSessionSkills = vi.fn();

vi.mock("@/hooks/use-agent-state", () => ({
  useActions: () => ({ listSkills, ensureSessionSkills }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  Trans: ({ i18nKey, values }: { i18nKey: string; values: { project: string } }) => (
    <>
      {i18nKey}:{values.project}
    </>
  ),
}));

afterEach(() => {
  cleanup();
  listSkills.mockReset();
  ensureSessionSkills.mockReset();
});

describe("EmptySessionOverview", () => {
  test("names the project folder and seeds default skills", async () => {
    const skills = [
      {
        name: "code-review",
        description: "Review pull requests carefully.",
        source: "project",
        manual: false,
      },
    ];
    listSkills.mockResolvedValue(skills);

    render(<EmptySessionOverview directory="/work/demo-site/" />);

    expect(screen.getByRole("heading").textContent).toBe("emptySession.headingInProject:demo-site");
    expect(screen.queryByRole("button")).toBeNull();
    await waitFor(() => expect(ensureSessionSkills).toHaveBeenCalledWith(skills));
  });

  test("falls back to a generic heading without a project", () => {
    render(<EmptySessionOverview directory={null} />);

    expect(screen.getByRole("heading").textContent).toBe("emptySession.heading");
    expect(ensureSessionSkills).not.toHaveBeenCalled();
  });
});
