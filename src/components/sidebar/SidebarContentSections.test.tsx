import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarSectionAction } from "./SidebarContentSections";

describe("Sidebar section actions", () => {
  test("removes collapsed actions from keyboard and accessibility navigation", () => {
    const collapsed = renderToStaticMarkup(
      <SidebarSectionAction collapsed label="Add project" onClick={() => {}} />,
    );
    const expanded = renderToStaticMarkup(
      <SidebarSectionAction collapsed={false} label="Add project" onClick={() => {}} />,
    );

    expect(collapsed).not.toContain("<button");
    expect(expanded).toContain('<button type="button" aria-label="Add project"');
  });
});
