import { describe, expect, test } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarRow } from "./SidebarRow";

describe("SidebarRow", () => {
  test("keeps row activation and named actions as sibling buttons", () => {
    const markup = renderToStaticMarkup(
      <SidebarRow
        label="Plan the launch"
        onActivate={() => {}}
        actions={<button type="button" aria-label="Pin to top" />}
      >
        <span>Plan the launch</span>
      </SidebarRow>,
    );

    expect(markup).toContain('<button type="button" aria-label="Plan the launch"');
    expect(markup).toContain('<button type="button" aria-label="Pin to top"');
    const primaryButton = markup.slice(
      markup.indexOf('aria-label="Plan the launch"'),
      markup.indexOf("</button>"),
    );
    expect(primaryButton).not.toContain('aria-label="Pin to top"');
  });
});
