import { describe, expect, test } from "vite-plus/test";
import {
  normalizePublicOrigin,
  isValidEmailAddress,
  renderEmailChangeMail,
  renderPreviousAddressNotice,
  renderTestMail,
  resolveMailLanguage,
} from "./mail.ts";

describe("single mailbox validation", () => {
  test("rejects address lists, display-name forms, quoted forms and controls", () => {
    for (const address of [
      "person@example.com,local-recipient",
      "Name<person@example.com>",
      '"quoted"@example.com',
      "person@exam\u0000ple.com",
    ]) {
      expect(isValidEmailAddress(address), address).toBe(false);
    }
    expect(isValidEmailAddress("person+tag@example.com")).toBe(true);
  });
});

describe("normalizePublicOrigin", () => {
  test("accepts plain https origins", () => {
    expect(normalizePublicOrigin("https://host.example.com")).toBe("https://host.example.com");
    expect(normalizePublicOrigin("https://host.example.com/")).toBe("https://host.example.com");
    expect(normalizePublicOrigin("HTTPS://HOST.EXAMPLE.COM")).toBe("https://host.example.com");
    expect(normalizePublicOrigin("https://host.example.com:8443")).toBe(
      "https://host.example.com:8443",
    );
  });

  test("rejects anything that is not a bare origin", () => {
    for (const hostile of [
      "https://host.example.com/?token=abc",
      "https://host.example.com/#fragment",
      "https://host.example.com/app",
      "https://host.example.com/app/",
      "https://user:secret@host.example.com",
      "https://user@host.example.com",
      "https://host.example.com/%2e%2e/x",
      "http://host.example.com",
      "http://192.168.1.10",
      "ftp://host.example.com",
      "not a url",
      "",
      "https://",
      "//host.example.com",
    ]) {
      expect(() => normalizePublicOrigin(hostile), hostile).toThrow();
    }
  });

  test("rejects unusable ports", () => {
    for (const hostile of [
      "https://host.example.com:0",
      "https://host.example.com:99999",
      "https://host.example.com:abc",
    ]) {
      expect(() => normalizePublicOrigin(hostile), hostile).toThrow();
    }
  });

  test("allows loopback origins including IPv6, https preferred", () => {
    expect(normalizePublicOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizePublicOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(normalizePublicOrigin("http://[::1]:3000")).toBe("http://[::1]:3000");
    expect(normalizePublicOrigin("https://[::1]")).toBe("https://[::1]");
    expect(() => normalizePublicOrigin("http://[::1]x/")).toThrow();
  });
});

describe("resolveMailLanguage", () => {
  test("negotiates en/de/es from Accept-Language, defaulting to English", () => {
    expect(resolveMailLanguage("de-AT, de;q=0.9, en;q=0.8")).toBe("de");
    expect(resolveMailLanguage("es")).toBe("es");
    expect(resolveMailLanguage("EN-US")).toBe("en");
    expect(resolveMailLanguage("fr, en;q=0.5")).toBe("en");
    expect(resolveMailLanguage("")).toBe("en");
    expect(resolveMailLanguage(null)).toBe("en");
    expect(resolveMailLanguage("de;rm -rf /")).toBe("de");
    expect(resolveMailLanguage("../../etc/passwd")).toBe("en");
  });
});

describe("localized mail templates", () => {
  test("confirmation mail is localized, plain text, and carries the exact URL", () => {
    const url = "https://host.example.com/#/confirm-email?token=abc";
    const german = renderEmailChangeMail({ confirmUrl: url, expiresMinutes: 30, language: "de" });
    expect(german.subject).not.toBe(
      renderEmailChangeMail({ confirmUrl: url, expiresMinutes: 30, language: "en" }).subject,
    );
    expect(german.text).toContain(url);
    expect(german.text).not.toContain("<");
    const spanish = renderEmailChangeMail({ confirmUrl: url, expiresMinutes: 30, language: "es" });
    expect(spanish.text).toContain(url);
    expect(spanish.text).not.toContain("<");
  });

  test("previous-address notice and test mail are localized", () => {
    expect(
      renderPreviousAddressNotice({ newEmail: "n@example.com", language: "de" }).subject,
    ).not.toBe(renderPreviousAddressNotice({ newEmail: "n@example.com", language: "en" }).subject);
    expect(
      renderPreviousAddressNotice({ newEmail: "n@example.com", language: "es" }).text,
    ).toContain("n@example.com");
    expect(renderTestMail({ language: "de" }).subject).not.toBe(
      renderTestMail({ language: "en" }).subject,
    );
  });
});

describe("sender display-name hygiene", () => {
  test("sanitizeDisplayName strips line breaks and controls", async () => {
    const { sanitizeDisplayName } = await import("./mail.ts");
    expect(sanitizeDisplayName("OpenGUI Host")).toBe("OpenGUI Host");
    expect(sanitizeDisplayName("Evil\r\nBcc: victim@example.com")).toBe(
      "EvilBcc: victim@example.com",
    );
    expect(sanitizeDisplayName("Tab\tSeparated\x00Null")).toBe("TabSeparatedNull");
    expect(sanitizeDisplayName("  padded  ")).toBe("padded");
  });

  test("the From header stays a single header with the configured address", async () => {
    const { buildFromHeader } = await import("./mail.ts");
    const header = buildFromHeader({
      host: "smtp.example.com",
      port: 587,
      username: "",
      password: "",
      fromAddress: "no-reply@example.com",
      fromName: "Owner\r\nBcc: attacker@example.com",
      useStarttls: true,
    });
    // One header line: no injected headers, and the envelope address is the
    // configured sender (the attacker text is inert quoted display text).
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
    expect(header.match(/<([^>]*)>/)?.[1]).toBe("no-reply@example.com");
  });
});
