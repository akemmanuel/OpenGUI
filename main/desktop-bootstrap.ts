import { createBeforeQuitHandler, shouldQuitWhenAllWindowsClosed } from "./desktop-shell.js";

interface DesktopWindowLike {
  isMinimized?: () => boolean;
  restore?: () => void;
  focus?: () => void;
}

interface DesktopAppLike {
  requestSingleInstanceLock(): boolean;
  whenReady(): Promise<unknown>;
  quit(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface DesktopBootstrapDependencies {
  app: DesktopAppLike;
  platform: NodeJS.Platform | (string & {});
  backend: { start(): Promise<unknown>; stop(): Promise<void> };
  createWindow(): DesktopWindowLike | void;
  getAllWindows(): DesktopWindowLike[];
  installReadyIntegrations(): void;
  showStartupError(error: Error): void;
  reportShutdownError(error: unknown): void;
}

/** Owns Electron process lifecycle while keeping the entrypoint dependency-only. */
export function bootstrapDesktopApp(input: DesktopBootstrapDependencies): Promise<void> {
  if (!input.app.requestSingleInstanceLock()) {
    input.app.quit();
    return Promise.resolve();
  }

  const focusOrCreateWindow = () => {
    const existing = input.getAllWindows()[0];
    if (!existing) {
      input.createWindow();
      return;
    }
    if (existing.isMinimized?.()) existing.restore?.();
    existing.focus?.();
  };

  input.app.on(
    "before-quit",
    createBeforeQuitHandler({
      stopBackend: () => input.backend.stop(),
      quit: () => input.app.quit(),
      reportError: (error) => input.reportShutdownError(error),
    }) as (...args: never[]) => void,
  );
  input.app.on("window-all-closed", (() => {
    if (shouldQuitWhenAllWindowsClosed(input.platform)) input.app.quit();
  }) as (...args: never[]) => void);

  const ready = input.app.whenReady().then(async () => {
    input.installReadyIntegrations();
    try {
      await input.backend.start();
    } catch (error) {
      input.showStartupError(error instanceof Error ? error : new Error(String(error)));
      input.app.quit();
      return;
    }
    input.createWindow();
    input.app.on("activate", focusOrCreateWindow as (...args: never[]) => void);
  });

  input.app.on("second-instance", (() => {
    void ready.then(focusOrCreateWindow);
  }) as (...args: never[]) => void);

  return ready;
}
