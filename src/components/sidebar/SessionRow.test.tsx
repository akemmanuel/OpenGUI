import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { sessionUiPermissions, SessionRowTitle } from "./SessionRow";

describe("SessionRowTitle", () => {
  test("exposes a resting Session title as text rather than an editable textbox", () => {
    const markup = renderToStaticMarkup(
      <SessionRowTitle displayTitle="Plan the launch" isUnread={false} onDoubleClick={() => {}} />,
    );

    expect(markup).toContain("Plan the launch");
    expect(markup).not.toContain('role="textbox"');
  });
});

describe("sessionUiPermissions", () => {
  test("keeps view and admin shares read-only while allowing admins to manage sharing", () => {
    expect(sessionUiPermissions("view")).toEqual({ manage: false, run: false, delete: false });
    expect(sessionUiPermissions("admin")).toEqual({ manage: true, run: false, delete: false });
  });

  test("allows Team runners to continue and reserves deletion for the owner", () => {
    expect(sessionUiPermissions("run")).toEqual({ manage: false, run: true, delete: false });
    expect(sessionUiPermissions("owner")).toEqual({ manage: true, run: true, delete: true });
  });
});
