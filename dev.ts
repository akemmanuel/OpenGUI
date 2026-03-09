/**
 * Dev script - replaces concurrently + wait-on.
 * Starts the Bun dev server, waits for it to be ready, then launches Electron.
 * Kills both processes on exit.
 */

const server = Bun.spawn(["bun", "--hot", "src/index.ts"], {
	stdio: ["inherit", "inherit", "inherit"],
	env: { ...Bun.env },
});

const url = "http://localhost:3000";
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

const electron = Bun.spawn(["bunx", "electron", "."], {
	stdio: ["inherit", "inherit", "inherit"],
	env: { ...Bun.env, BUN_DEV_SERVER_URL: url },
});

// When Electron closes, kill the server and exit
const exitCode = await electron.exited;
server.kill();
process.exit(exitCode);
