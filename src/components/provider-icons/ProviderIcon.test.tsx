import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderIcon } from "./ProviderIcon";

describe("ProviderIcon", () => {
  test("marks provider icons as decorative and non-focusable", () => {
    const markup = renderToStaticMarkup(
      <ProviderIcon provider="openai" className="size-4" aria-label="OpenAI" />,
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
    expect(markup).toContain('class="size-4"');
    expect(markup).toContain('data-provider-icon="openai"');
    expect(markup).toContain('viewBox="0 0 40 40"');
    expect(markup).toContain('fill="currentColor"');
  });

  test("falls back to the synthetic icon for unknown providers", () => {
    const markup = renderToStaticMarkup(<ProviderIcon provider="not-a-provider" />);

    expect(markup).toContain('data-provider-icon="synthetic"');
    expect(markup).toContain('stroke="currentColor"');
  });
});
