import { beforeAll, describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "@/i18n";
import { PathGrantRows } from "./PathGrantEditor";

describe("PathGrantRows", () => {
  beforeAll(async () => {
    await initI18n();
  });

  test("states explicitly that an empty grant list has no project access", () => {
    const markup = renderToStaticMarkup(<PathGrantRows grants={[]} onChange={() => {}} />);
    expect(markup).toContain("No project access");
    expect(markup).toContain("cannot open any directory-backed Projects");
  });

  test("presents roots, access levels, and a remove action", () => {
    const markup = renderToStaticMarkup(
      <PathGrantRows grants={[{ root: "/srv/project", access: "read" }]} onChange={() => {}} />,
    );
    expect(markup).toContain("/srv/project");
    expect(markup).toContain("Read only");
    expect(markup).toContain("Remove /srv/project");
  });
});
