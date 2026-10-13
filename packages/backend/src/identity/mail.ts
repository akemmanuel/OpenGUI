import { createTransport, type Transporter } from "nodemailer";

export type MailMessage = {
  to: string;
  subject: string;
  /** Plain text only: confirmation mail must not load third-party assets. */
  text: string;
};

export type MailSender = (message: MailMessage) => Promise<void>;

export type SmtpMailSettings = {
  host: string;
  port: number;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  useStarttls: boolean;
};

export type StoredMailConfig = {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string;
  useStarttls: boolean;
  publicOrigin: string;
};

export type MailConfigInput = {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  /**
   * Omitted/undefined keeps the stored secret; "" clears it; anything else
   * replaces it. The secret itself lives in Host secret storage, never in the
   * identity database.
   */
  password?: string;
  fromAddress: string;
  fromName: string;
  useStarttls: boolean;
  publicOrigin: string;
};

export const EMAIL_CHANGE_TOKEN_TTL_MS = 30 * 60 * 1000;
export const EMAIL_CHANGE_MAX_OUTSTANDING = 3;
export const EMAIL_CHANGE_MAX_REQUESTS_PER_HOUR = 5;
/** Failed password verifications per account per rolling hour. */
export const EMAIL_CHANGE_MAX_REAUTH_PER_HOUR = 10;
/** Host-wide password verifications per rolling hour (CPU bound for scrypt). */
export const EMAIL_CHANGE_MAX_GLOBAL_REAUTH_PER_HOUR = 300;
export const EMAIL_CHANGE_MAX_CONFIRM_ATTEMPTS = 10;
/** Host-wide confirmations per rolling hour (all callers share this budget). */
export const EMAIL_CHANGE_MAX_CONFIRMS_PER_HOUR = 120;
/** Host-wide change requests per rolling hour, across all accounts. */
export const EMAIL_CHANGE_MAX_GLOBAL_REQUESTS_PER_HOUR = 500;
/** Superseded/cancelled/failed rows are pruned after this long. */
export const EMAIL_CHANGE_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
export const SMTP_SOCKET_TIMEOUT_MS = 20_000;
/** Total delivery budget, independent of socket activity or SMTP phase. */
export const SMTP_DELIVERY_TIMEOUT_MS = 40_000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailAddress(value: string): boolean {
  // Accept a single simple mailbox, not Nodemailer's address-list/display-name
  // grammar. The address verified by the token must equal the stored contact.
  const separators = ["<", ">", ",", ";", ":", '"', "\\", "(", ")", "[", "]"];
  return (
    value.length <= 254 &&
    EMAIL_PATTERN.test(value) &&
    !hasHeaderControls(value) &&
    !separators.some((separator) => value.includes(separator))
  );
}

export type MailLanguage = "en" | "de" | "es";

/**
 * Bounded Accept-Language negotiation over the fixed en/de/es template set.
 * No filesystem lookup, no path handling: unknown or malformed input yields
 * English. Only the primary subtag of the first entry is considered.
 */
export function resolveMailLanguage(header: string | null | undefined): MailLanguage {
  if (!header) return "en";
  const first = header.split(",")[0]?.split(";")[0]?.trim().toLowerCase();
  const primary = first?.split("-")[0]?.split("_")[0] ?? "";
  return primary === "de" || primary === "es" ? primary : "en";
}

function loopbackHostname(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

/**
 * Normalizes an explicitly owner-configured public origin for confirmation links.
 * Only a bare `scheme://host[:port]` is accepted: no credentials, path, query,
 * or fragment. HTTPS is required; plain HTTP is accepted only for loopback hosts
 * (local development and deterministic tests). Request Host headers or
 * container-internal URLs must never reach this value's consumers.
 */
export function normalizePublicOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("public origin must be an absolute URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("public origin must not embed credentials");
  }
  const https = parsed.protocol === "https:";
  const httpLoopback = parsed.protocol === "http:" && loopbackHostname(parsed.hostname);
  if (!https && !httpLoopback) {
    throw new Error("public origin must be an HTTPS URL (HTTP only for loopback)");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("public origin must be a bare origin without path, query, or fragment");
  }
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("public origin port must be 1-65535");
    }
  }
  if (!parsed.hostname) throw new Error("public origin must include a host");
  return `${parsed.protocol}//${parsed.host}`;
}

export function buildEmailChangeUrl(publicOrigin: string, token: string): string {
  return `${normalizePublicOrigin(publicOrigin)}/#/confirm-email?token=${encodeURIComponent(token)}`;
}

type MailTemplates = {
  confirmSubject: string;
  confirmIntro: string;
  confirmCallToAction: (minutes: number) => string;
  confirmIgnore: string;
  changedSubject: string;
  changedBody: (newEmail: string) => string;
  testSubject: string;
  testBody: string;
};

const MAIL_TEMPLATES: Record<MailLanguage, MailTemplates> = {
  en: {
    confirmSubject: "Confirm your new email address",
    confirmIntro:
      "Someone requested that this address become the contact email for an OpenGUI Host account.",
    confirmCallToAction: (minutes) =>
      `If this was you, confirm within the next ${minutes} minutes by opening this link:`,
    confirmIgnore:
      "If you did not request this, ignore this message: nothing changes until the link is used.",
    changedSubject: "Your OpenGUI contact email was changed",
    changedBody: (newEmail) =>
      [
        `The contact email for your OpenGUI Host account was changed to ${newEmail}.`,
        "",
        "Your username and password are unchanged. If you did not request this,",
        "contact the Host owner immediately.",
      ].join("\n"),
    testSubject: "OpenGUI test mail",
    testBody: "This test message confirms mail delivery is configured on your OpenGUI Host.",
  },
  de: {
    confirmSubject: "Bestätige deine neue E-Mail-Adresse",
    confirmIntro:
      "Für ein OpenGUI-Host-Konto wurde beantragt, dass diese Adresse die neue Kontakt-E-Mail wird.",
    confirmCallToAction: (minutes) =>
      `Wenn du das warst, bestätige innerhalb der nächsten ${minutes} Minuten über diesen Link:`,
    confirmIgnore:
      "Wenn du das nicht warst, ignoriere diese Nachricht: Ohne den Link ändert sich nichts.",
    changedSubject: "Deine OpenGUI-Kontakt-E-Mail wurde geändert",
    changedBody: (newEmail) =>
      [
        `Die Kontakt-E-Mail deines OpenGUI-Host-Kontos wurde zu ${newEmail} geändert.`,
        "",
        "Benutzername und Passwort sind unverändert. Wenn du das nicht warst,",
        "wende dich sofort an die Host-Administration.",
      ].join("\n"),
    testSubject: "OpenGUI-Testmail",
    testBody:
      "Diese Testnachricht bestätigt, dass der E-Mail-Versand auf deinem OpenGUI-Host eingerichtet ist.",
  },
  es: {
    confirmSubject: "Confirma tu nueva dirección de correo",
    confirmIntro:
      "Se ha solicitado que esta dirección sea el nuevo correo de contacto de una cuenta del Host OpenGUI.",
    confirmCallToAction: (minutes) =>
      `Si fuiste tú, confirma dentro de ${minutes} minutos abriendo este enlace:`,
    confirmIgnore: "Si no fuiste tú, ignora este mensaje: sin el enlace no cambia nada.",
    changedSubject: "Tu correo de contacto de OpenGUI ha cambiado",
    changedBody: (newEmail) =>
      [
        `El correo de contacto de tu cuenta del Host OpenGUI ha cambiado a ${newEmail}.`,
        "",
        "Tu nombre de usuario y tu contraseña no han cambiado. Si no fuiste tú,",
        "contacta de inmediato con la persona propietaria del Host.",
      ].join("\n"),
    testSubject: "Correo de prueba de OpenGUI",
    testBody:
      "Este mensaje de prueba confirma que el envío de correo está configurado en tu Host OpenGUI.",
  },
};

export function renderEmailChangeMail(options: {
  confirmUrl: string;
  expiresMinutes: number;
  language?: MailLanguage;
}): { subject: string; text: string } {
  const templates = MAIL_TEMPLATES[options.language ?? "en"];
  return {
    subject: templates.confirmSubject,
    text: [
      templates.confirmIntro,
      "",
      templates.confirmCallToAction(options.expiresMinutes),
      options.confirmUrl,
      "",
      templates.confirmIgnore,
    ].join("\n"),
  };
}

export function renderPreviousAddressNotice(options: {
  newEmail: string;
  language?: MailLanguage;
}): { subject: string; text: string } {
  const templates = MAIL_TEMPLATES[options.language ?? "en"];
  return { subject: templates.changedSubject, text: templates.changedBody(options.newEmail) };
}

export function renderTestMail(options: { language?: MailLanguage }): {
  subject: string;
  text: string;
} {
  const templates = MAIL_TEMPLATES[options.language ?? "en"];
  return { subject: templates.testSubject, text: templates.testBody };
}

export function isLoopbackSmtpHost(host: string): boolean {
  return loopbackHostname(host.trim());
}

/** Rejects header-unsafe display names (CR/LF and other control characters). */
function hasHeaderControls(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isSafeDisplayName(value: string): boolean {
  return value.length <= 100 && !hasHeaderControls(value);
}

/**
 * Defense-in-depth sanitizer for the sender display name: strips line breaks
 * and control characters so a stored value can never smuggle extra headers
 * or recipients into the message. Owner input is additionally rejected at
 * save time; this keeps the send path safe regardless.
 */
export function sanitizeDisplayName(value: string): string {
  let kept = "";
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index) ?? 0;
    if (code > 0x1f && code !== 0x7f) kept += String.fromCodePoint(code);
    index += code > 0xffff ? 2 : 1;
  }
  return kept.trim().slice(0, 100);
}

export function buildFromHeader(settings: SmtpMailSettings): string {
  const name = sanitizeDisplayName(settings.fromName);
  return name ? `"${name.replace(/"/g, "")}" <${settings.fromAddress}>` : settings.fromAddress;
}

/**
 * TLS policy for the SMTP sender: port 465 always uses implicit TLS; every
 * other host outside the approved loopback relay requires STARTTLS, regardless
 * of the toggle. The toggle is honored only for loopback relays (local
 * development and tests). Phase limits are supplemented by a total delivery
 * deadline in createSmtpSender, including peers that never become idle.
 */
export function smtpTransportOptions(settings: SmtpMailSettings): {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string } | undefined;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
} {
  const implicitTls = settings.port === 465;
  return {
    host: settings.host,
    port: settings.port,
    secure: implicitTls,
    requireTLS: implicitTls ? false : settings.useStarttls || !isLoopbackSmtpHost(settings.host),
    auth:
      settings.username || settings.password
        ? { user: settings.username, pass: settings.password }
        : undefined,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  };
}

export function createSmtpSender(settings: SmtpMailSettings): MailSender {
  const transporter: Transporter = createTransport(smtpTransportOptions(settings));
  return async (message) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transporter.sendMail({
          from: buildFromHeader(settings),
          to: message.to,
          subject: message.subject,
          text: message.text,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Mail delivery timed out")),
            SMTP_DELIVERY_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Also close a trickling/hung transport when the total deadline wins.
      if (typeof transporter.close === "function") transporter.close();
    }
  };
}
