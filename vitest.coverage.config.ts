import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const configDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: configDir,
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(configDir, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  test: {
    // Seeded persistence properties run comfortably in the normal suite but
    // need extra headroom when V8 instruments every storage transition.
    testTimeout: 15_000,
    include: [
      "src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "packages/{protocol,backend,harness}/src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "server/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "lib/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "main/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    coverage: {
      provider: "v8",
      allowExternal: false,
      reportsDirectory: "coverage",
      reporter: ["text", "json", "json-summary", "html"],
      include: [
        "src/**/*.{ts,tsx}",
        "packages/{protocol,backend,harness}/src/**/*.ts",
        "main.ts",
        "preload.ts",
        "settings-store.ts",
        "main/**/*.ts",
        "server/**/*.ts",
        "lib/**/*.ts",
      ],
      exclude: [
        "**/*.{test,spec}.{ts,tsx}",
        "**/*.d.ts",
        "**/__tests__/**",
        "packages/harness/src/test/**",
        // Passive shadcn/Base UI wrappers contain no product decisions. Stateful
        // sidebar primitives and OpenGUI-owned PascalCase primitives remain in scope.
        "src/components/ui/{alert-dialog,alert,badge,button,checkbox,context-menu,dialog,dropdown-menu,input,label,popover,select,separator,sheet,skeleton,slider,sonner,spinner,switch,tabs,toggle-group,toggle,tooltip}.tsx",
      ],
      thresholds: {
        lines: 61,
        branches: 48,
        functions: 54,
        statements: 58,
        "packages/backend/src/**": {
          lines: 70,
          branches: 55,
          functions: 70,
          statements: 65,
        },
        "packages/backend/src/host/opengui-host.ts": {
          lines: 75,
          branches: 53,
          functions: 80,
          statements: 73,
        },
        "packages/harness/src/**": {
          lines: 85,
          branches: 65,
          functions: 90,
          statements: 80,
        },
        "packages/harness/src/models/{codex-responses,openai-chat}.ts": {
          lines: 80,
          branches: 60,
          functions: 65,
          statements: 77,
        },
        "main/**/*.ts": {
          lines: 78,
          branches: 70,
          functions: 65,
          statements: 75,
        },
        "src/components/AppSidebar.tsx": {
          lines: 80,
          branches: 50,
          functions: 55,
          statements: 75,
        },
        "src/components/TitleBar.tsx": {
          lines: 90,
          branches: 70,
          functions: 90,
          statements: 90,
        },
        "src/components/title-bar/{WorkspaceDialog,WorkspaceTabs}.tsx": {
          lines: 75,
          branches: 60,
          functions: 90,
          statements: 75,
        },
        "src/components/sidebar-item-menus/SessionMenuContent.tsx": {
          lines: 90,
          branches: 70,
          functions: 80,
          statements: 80,
        },
        "src/features/identity/{SessionShareDialog,ViewLinkScreen}.tsx": {
          lines: 95,
          branches: 75,
          functions: 95,
          statements: 90,
        },
        "src/features/session/{useActiveSessionQueue,useChatSessionSurface}.ts": {
          lines: 100,
          branches: 60,
          functions: 100,
          statements: 75,
        },
        "src/features/session-transcript/{transcript-viewport.tsx,use-pinned-scroll.ts}": {
          lines: 95,
          branches: 75,
          functions: 90,
          statements: 85,
        },
      },
    },
  },
});
