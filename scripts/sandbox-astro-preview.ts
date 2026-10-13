import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function astroPreviewOptions(root: string) {
  return {
    root,
    server: { host: "0.0.0.0", port: 3000 },
    vite: {
      server: {
        watch: {
          usePolling: true,
          interval: 1000,
          // Poll source, not generated output, browser artifacts, or thousands
          // of static uploads. Public assets are still read directly on request.
          ignored: [
            "**/node_modules/**",
            "**/.git/**",
            "**/.astro/**",
            "**/dist/**",
            "**/.opengui-qa/**",
            "**/.opengui-uploads/**",
            "**/public/**",
          ],
        },
      },
    },
  };
}

async function main() {
  const root = process.cwd();
  const require = createRequire(join(root, "package.json"));
  const { dev } = await import(pathToFileURL(require.resolve("astro")).href);
  const server = await dev(astroPreviewOptions(root));
  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
