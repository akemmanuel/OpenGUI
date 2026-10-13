import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createSmtpSender } from "./mail.ts";

const smtp = vi.hoisted(() => ({ sendMail: vi.fn(), close: vi.fn() }));
vi.mock("nodemailer", () => ({ createTransport: () => smtp }));

const settings = {
  host: "smtp.example.com",
  port: 587,
  username: "fixture-user",
  password: "fixture-password",
  fromAddress: "no-reply@example.com",
  fromName: "Fixture Host",
  useStarttls: true,
};
const message = { to: "fixture@example.com", subject: "Fixture", text: "No real mail" };

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("SMTP delivery lifecycle", () => {
  test("bounds the entire delivery even if transport activity never becomes idle", async () => {
    vi.useFakeTimers();
    smtp.sendMail.mockImplementation(() => new Promise<void>(() => {}));
    let outcome = "pending";
    const pending = createSmtpSender(settings)(message).then(
      () => {
        outcome = "sent";
      },
      () => {
        outcome = "failed";
      },
    );
    // Connect/greeting/inactivity limits do not bound a peer that keeps
    // trickling data. The sender itself must impose a total deadline.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(outcome).toBe("failed");
    expect(smtp.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await pending;
  });

  test("releases transport and deadline after successful delivery", async () => {
    vi.useFakeTimers();
    smtp.sendMail.mockResolvedValue({ messageId: "fixture-message" });
    await createSmtpSender(settings)(message);
    expect(smtp.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("releases transport and deadline after delivery failure", async () => {
    vi.useFakeTimers();
    smtp.sendMail.mockRejectedValue(new Error("fixture delivery failure"));
    await expect(createSmtpSender(settings)(message)).rejects.toThrow("fixture delivery failure");
    expect(smtp.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
