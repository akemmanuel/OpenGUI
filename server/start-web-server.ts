import { serve as honoServe } from "@hono/node-server";
import { createBackendHost as createHost } from "@opengui/backend";
import packageJson from "../package.json" with { type: "json" };

type BackendHost = ReturnType<typeof createHost>;
type Server = ReturnType<typeof honoServe>;

export interface WebServerDependencies {
  createBackendHost: () => BackendHost;
  serve: typeof honoServe;
  info: (message: string) => void;
  startupError: (error: Error) => void;
}

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
  const { env, app } = createBackendHost();
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
  return server;
}
