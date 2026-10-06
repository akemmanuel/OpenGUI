// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { EmailConfirmScreen } from "./EmailConfirmScreen";

const workspace = { id: "host", name: "Test Host", serverUrl: "https://host.example" };
const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

function envelope(value: Record<string, unknown>, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(ok ? { ok: true, value } : { ok: false, ...value }),
  };
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "#/confirm-email?token=secret-token";
});

test("confirms once, strips the token, and shows success", async () => {
  fetchMock.mockResolvedValueOnce(envelope({ changed: true }));
  render(<EmailConfirmScreen token="secret-token" workspace={workspace as never} />);
  await waitFor(() => expect(screen.getByText("account.confirmEmailSuccess")).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://host.example/api/identity/email-change/confirm");
  expect(JSON.parse(init.body as string)).toEqual({ token: "secret-token" });
  expect(window.location.hash).not.toContain("secret-token");
});

test("shows an invalid-link message for expired tokens", async () => {
  fetchMock.mockResolvedValueOnce(envelope({ error: "bad", code: "INVALID_TOKEN" }, false, 400));
  render(<EmailConfirmScreen token="stale-token" workspace={workspace as never} />);
  await waitFor(() => expect(screen.getByText("account.confirmEmailInvalid")).toBeTruthy());
  expect(window.location.hash).not.toContain("stale-token");
});

test("confirms exactly once under StrictMode double effects", async () => {
  fetchMock.mockResolvedValueOnce(envelope({ changed: true }));
  render(
    <StrictMode>
      <EmailConfirmScreen token="strict-token" workspace={workspace as never} />
    </StrictMode>,
  );
  await waitFor(() => expect(screen.getByText("account.confirmEmailSuccess")).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("distinguishes an address taken after the request", async () => {
  fetchMock.mockResolvedValueOnce(
    envelope({ error: "taken", code: "EMAIL_UNAVAILABLE" }, false, 409),
  );
  render(<EmailConfirmScreen token="late-token" workspace={workspace as never} />);
  await waitFor(() => expect(screen.getByText("account.confirmEmailTaken")).toBeTruthy());
});
