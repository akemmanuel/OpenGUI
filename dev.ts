/**
 * Dev script - replaces concurrently + wait-on.
 * Starts the Bun dev server, waits for it to be ready, then launches Electron.
 * Kills both processes on exit.
 */

const host = "127.0.0.1";
const port = Number(Bun.env.OPENGUI_VITE_PORT || 5173);
const url = `http://${host}:${port}`;

const server = Bun.spawn(["vp", "dev", "--host", host, "--port", String(port)], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...Bun.env, OPENGUI_SKIP_WEB_BACKEND: "1" },
});

const maxAttempts = 60;

for (let i = 0; i < maxAttempts; i++) {
  try {
    await fetch(url);
    break;
  } catch {
    if (i === maxAttempts - 1) {
      console.error(`Server did not start within ${maxAttempts} seconds`);
      server.kill();
      process.exit(1);
    }
    await Bun.sleep(1000);
  }
}

const electron = Bun.spawn(["electron", "."], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...Bun.env, BUN_DEV_SERVER_URL: url },
});

// When Electron closes, kill the server and exit
const exitCode = await electron.exited;
server.kill();
process.exit(exitCode);
