import { describe, expect, it } from "vite-plus/test";
import { readEmailChangeToken, removeEmailChangeToken } from "./email-confirm-url";

describe("email confirmation URL helpers", () => {
  it("reads tokens only from the exact fragment confirmation route", () => {
    expect(readEmailChangeToken("https://app.example/#/confirm-email?token=abc-123")).toBe(
      "abc-123",
    );
    expect(readEmailChangeToken("https://app.example/#/confirm-email?emailChange=legacy-1")).toBe(
      "legacy-1",
    );
    expect(readEmailChangeToken("https://app.example/#/chat")).toBeNull();
  });

  it("rejects prefix routes and query aliases so tokens never ride to the server", () => {
    expect(readEmailChangeToken("https://app.example/?emailChange=query-token#/chat")).toBeNull();
    expect(readEmailChangeToken("https://app.example/?emailChange=query-token")).toBeNull();
    expect(readEmailChangeToken("https://app.example/#/confirm-email-other?token=x")).toBeNull();
    expect(
      readEmailChangeToken("https://app.example/#/confirm-email-other?emailChange=x"),
    ).toBeNull();
    expect(readEmailChangeToken("https://app.example/#/confirm-email")).toBeNull();
  });

  it("strips confirmation secrets while preserving unrelated URL state", () => {
    expect(removeEmailChangeToken("https://app.example/?theme=dark#/confirm-email?token=abc")).toBe(
      "https://app.example/?theme=dark#/confirm-email",
    );
    expect(removeEmailChangeToken("https://app.example/?emailChange=abc&theme=dark#/chat")).toBe(
      "https://app.example/?theme=dark#/chat",
    );
  });
});
