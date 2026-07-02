import { serve } from "@hono/node-server";
import { createBackendHost } from "@opengui/backend";

const { env, app } = createBackendHost();

serve(
  {
    fetch: app.fetch,
    hostname: env.hostname,
    port: env.port,
    overrideGlobalObjects: false,
  },
  () => {
    console.info(
      `OpenGUI ${env.servesFrontend ? "combined" : "API-only"} running at http://${env.hostname}:${env.port}`,
    );
  },
);
