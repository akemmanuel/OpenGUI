export async function waitForDevelopmentServers(input: {
  frontendUrl: string;
  backendUrl: string;
  attempts: number;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<unknown>;
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < input.attempts; attempt += 1) {
    try {
      const [frontend, backend] = await Promise.all([
        input.fetch(input.frontendUrl),
        input.fetch(`${input.backendUrl}/api/health`),
      ]);
      if (!frontend.ok) throw new Error(`Frontend readiness returned ${frontend.status}`);
      if (!backend.ok) throw new Error(`Host health returned ${backend.status}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < input.attempts) await input.sleep(1000);
    }
  }
  throw new Error(`Development servers did not become healthy after ${input.attempts} attempts`, {
    cause: lastError,
  });
}
