// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { WorkspaceContext, type WorkspaceContextValue } from "@/hooks/agent-contexts";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { HostImage } from "./HostImage";

const SRC = "https://host.example/api/fs/file?path=%2Fsrv%2Fproject%2Fshot.png";

function renderWithToken(token: string | null) {
  render(
    <WorkspaceContext.Provider
      value={{ attachmentAuthToken: token } as unknown as WorkspaceContextValue}
    >
      <HostImage src={SRC} alt="shot" />
    </WorkspaceContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HostImage", () => {
  test("loads directly when the Host needs no bearer token", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderWithToken(null);
    expect((screen.getByRole("img", { name: "shot" }) as HTMLImageElement).src).toBe(SRC);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("fetches with the Remote Host token and shows a blob url", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" })));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:host-image");
    renderWithToken("ogk_secret");

    await waitFor(() =>
      expect((screen.getByRole("img", { name: "shot" }) as HTMLImageElement).src).toBe(
        "blob:host-image",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      SRC,
      expect.objectContaining({ headers: { authorization: "Bearer ogk_secret" } }),
    );
  });

  test("shows the unavailable placeholder when the Host rejects the path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("forbidden", { status: 403 })),
    );
    renderWithToken("ogk_secret");
    await waitFor(() => expect(screen.getByText("attachments.imageUnavailable")).toBeTruthy());
  });
});
