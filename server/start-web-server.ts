import { serve as honoServe } from "@hono/node-server";
import { createBackendHost as createHost } from "@opengui/backend";
import { Cause, Effect, Exit } from "effect";
import packageJson from "../package.json" with { type: "json" };

type BackendHost = ReturnType<typeof createHost>;
type Server = ReturnType<typeof honoServe>;

export interface WebServerDependencies {
  createBackendHost: () => BackendHost;
  serve: typeof honoServe;
  info: (message: string) => void;
  startupError: (error: Error) => void;
  /** Registers process signal handlers; tests replace it to avoid global listeners. */
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  exit: (code: number) => void;
}

/** Upper bound for draining runs before the process exits anyway (Docker sends
 * SIGKILL after its own stop timeout, 10 s by default). */
const SHUTDOWN_TIMEOUT_MS = 8_000;

export function startWebServer(dependencies: Partial<WebServerDependencies> = {}): Server {
  process.env.OPENGUI_VERSION ??= packageJson.version;
  const createBackendHost = dependencies.createBackendHost ?? createHost;
  const serve = dependencies.serve ?? honoServe;
  const info = dependencies.info ?? console.info;
  const startupError =
    dependencies.startupError ??
    ((error: Error) => {
      console.error("OpenGUI failed to bind its HTTP server", error);
      process.exitCode = 1;
    });
  const onSignal =
    dependencies.onSignal ??
    ((signal: NodeJS.Signals, handler: () => void) => void process.once(signal, handler));
  const exit = dependencies.exit ?? ((code: number) => process.exit(code));
  const backend = createBackendHost();
  const { env, app } = backend;
  const server = serve(
    {
      fetch: app.fetch,
      hostname: env.hostname,
      port: env.port,
      overrideGlobalObjects: false,
    },
    () => {
      info(
        `OpenGUI ${env.servesFrontend ? "combined" : "API-only"} running at http://${env.hostname}:${env.port}`,
      );
    },
  );
  server.once("error", (error) => {
    startupError(error);
  });

  // Without this, `docker stop` kills the Host mid-write: active runs are cut
  // off and the durable state lock is left behind for the next start.
  const stop = Effect.sync(() => server.close()).pipe(
    Effect.andThen(Effect.promise(() => backend.close())),
    Effect.timeoutOrElse({
      duration: SHUTDOWN_TIMEOUT_MS,
      orElse: () => Effect.fail(new Error("Timed out stopping the Host")),
    }),
  );
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    info(`OpenGUI received ${signal}; stopping runs and closing state`);
    void Effect.runPromiseExit(stop).then((result) => {
      if (Exit.isFailure(result))
        console.error("OpenGUI shutdown failed", Cause.squash(result.cause));
      exit(Exit.isSuccess(result) ? 0 : 1);
    });
  };
  onSignal("SIGTERM", () => shutdown("SIGTERM"));
  onSignal("SIGINT", () => shutdown("SIGINT"));
  return server;
}
