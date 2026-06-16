import { describe, expect, test, beforeAll } from "@voidzero-dev/vite-plus-test";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "@/i18n";
import { NoProjectConnected, NoSessionSelected } from "./EmptyChatStates";

describe("EmptyChatStates", () => {
  beforeAll(async () => {
    await initI18n();
  });
  test("NoProjectConnected invites project connection when chat cannot start", () => {
    const markup = renderToStaticMarkup(
      <NoProjectConnected canStartChat={false} onStartChat={() => {}} />,
    );

    expect(markup).toContain("No project connected");
    expect(markup).toContain("Connect a project to start chatting.");
    expect(markup).not.toContain("Start a chat");
  });

  test("NoProjectConnected exposes the start chat action when allowed", () => {
    const markup = renderToStaticMarkup(
      <NoProjectConnected canStartChat={true} onStartChat={() => {}} />,
    );

    expect(markup).toContain("Connect a project now or start a chat.");
    expect(markup).toContain("<button");
    expect(markup).toContain('type="button"');
    expect(markup).toContain("Start a chat");
  });

  test("NoSessionSelected explains how to continue", () => {
    const markup = renderToStaticMarkup(<NoSessionSelected />);

    expect(markup).toContain("No session selected");
    expect(markup).toContain("Select a session or start a new one from a connected project.");
  });
});
