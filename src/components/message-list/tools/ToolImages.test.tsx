// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}:${options.name}` : key,
  }),
}));
vi.mock("@/hooks/use-agent-state", () => ({
  useWorkspaceState: () => ({ attachmentBaseUrl: "http://127.0.0.1:36627" }),
}));

import { ToolImages } from "./ToolCallOutputView";

afterEach(cleanup);

describe("ToolImages", () => {
  test("opens a generated image in the lightbox on click and closes it again", async () => {
    const path = "/home/me/project/.opengui-images/mouse.png";
    const src = `http://127.0.0.1:36627/api/fs/file?path=${encodeURIComponent(path)}`;
    render(
      <ToolImages
        block={{
          type: "images",
          images: [{ url: path, src, mime: "image/png", filename: "mouse.png" }],
        }}
        large
      />,
    );

    expect(screen.getAllByRole("img", { name: "mouse.png" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "attachments.openImage:mouse.png" }));

    const images = screen.getAllByRole("img", { name: "mouse.png" }) as HTMLImageElement[];
    expect(images).toHaveLength(2);
    expect(images[1]!.src).toBe(images[0]!.src);
    expect(screen.getByText(path)).toBeTruthy();

    await userEvent.keyboard("{Escape}");
    expect(screen.getAllByRole("img", { name: "mouse.png" })).toHaveLength(1);
  });
});
