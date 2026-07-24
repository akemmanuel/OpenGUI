import { describe, expect, it } from "vite-plus/test";
import { buildInviteLink, readInviteToken, removeInviteToken } from "./invite-url";

describe("invite URL helpers", () => {
  it("reads query and hash-router invite tokens", () => {
    expect(readInviteToken("https://app.example/?invite=secret%20token")).toBe("secret token");
    expect(readInviteToken("https://app.example/#/join?invite=hash-token")).toBe("hash-token");
  });

  it("builds a link without discarding unrelated URL state", () => {
    expect(buildInviteLink("https://app.example/?theme=dark#/chat", "abc")).toBe(
      "https://app.example/?theme=dark&invite=abc#/chat",
    );
  });

  it("removes invite secrets after acceptance", () => {
    expect(removeInviteToken("https://app.example/?invite=abc&theme=dark#/chat")).toBe(
      "https://app.example/?theme=dark#/chat",
    );
  });
});
