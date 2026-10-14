/**
 * Operator password recovery for a Remote Host, including the owner account.
 *
 * Run on the Host with the same OPENGUI_DATA_DIR as the server, for example:
 *   docker exec -it opengui node --experimental-strip-types scripts/reset-password.ts alice
 *
 * Prints a one-time temporary password (or reads one from OPENGUI_NEW_PASSWORD),
 * signs the account out everywhere, and records an audit event. The person should
 * change the password from the profile menu after signing in.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IdentityService } from "@opengui/backend";

export function temporaryPassword() {
  return randomBytes(15).toString("base64url");
}

export async function resetPassword(
  identity: Pick<IdentityService, "operatorResetPassword">,
  username: string,
  password = temporaryPassword(),
) {
  await identity.operatorResetPassword(username, password);
  return password;
}

async function main() {
  const username = process.argv[2]?.trim();
  if (!username) {
    console.error("Usage: reset-password.ts <username-or-email>");
    process.exit(2);
  }
  const identity = new IdentityService();
  let password: string;
  try {
    password = await resetPassword(
      identity,
      username,
      process.env.OPENGUI_NEW_PASSWORD || undefined,
    );
  } finally {
    await identity.close();
  }
  console.info(`Password reset for ${username}. All sessions were signed out.`);
  if (!process.env.OPENGUI_NEW_PASSWORD) {
    console.info(`Temporary password: ${password}`);
    console.info("Share it privately and ask them to change it after signing in.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Password reset failed");
    process.exit(1);
  });
}
