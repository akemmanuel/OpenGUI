import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  BackendEventBus,
  createStorageService,
  PromptQueueService,
  SessionDispatchIndex,
  registerSharedSessionControl,
  type BackendServiceContext,
} from "../../../../server/services/index.ts";
import {
  createHarnessService,
  createRuntimeHost,
  createSessionTranscripts,
  InProcessIpcMain,
  InProcessIpcSender,
} from "@opengui/runtime";

export async function createBackendServiceContext(
  ipcMain: InProcessIpcMain,
  sender: InProcessIpcSender,
  broadcast: (channel: string, data: unknown) => void,
  resolveSafeDirectory: (inputPath: string | null) => Promise<string>,
): Promise<BackendServiceContext> {
  const dataDir = resolve(
    process.env.OPENGUI_DATA_DIR || join(homedir(), ".config", "OpenGUI-web"),
  );
  await mkdir(dataDir, { recursive: true });

  const storage = await createStorageService(dataDir);
  const events = new BackendEventBus();
  const sessions = new SessionDispatchIndex(storage, events);
  const runtimeHost = createRuntimeHost({ ipcMain, sender, dataDir, broadcast });
  const servicesStub: Partial<BackendServiceContext> & {
    dataDir: string;
    storage: Awaited<ReturnType<typeof createStorageService>>;
    events: BackendEventBus;
    sessions: SessionDispatchIndex;
    transcripts: ReturnType<typeof createSessionTranscripts>;
  } = {
    dataDir,
    storage,
    events,
    sessions,
    transcripts: createSessionTranscripts(),
  };
  const harnesses = createHarnessService({
    invoke: <T>(channel: string, args: unknown[] = []) =>
      ipcMain.invoke(channel, { sender }, args) as Promise<T>,
    controls: runtimeHost.controls,
    managedHarnessIds: runtimeHost.managedHarnessIds,
    events,
  });
  servicesStub.harnesses = harnesses;
  servicesStub.restartHarness = (harnessId: string) => harnesses.restartHarness(harnessId);
  servicesStub.restartAllHarnesses = () => harnesses.restartAllHarnesses();
  const queues = new PromptQueueService(
    servicesStub as BackendServiceContext,
    resolveSafeDirectory,
  );
  servicesStub.queues = queues;

  const services = servicesStub as BackendServiceContext;
  registerSharedSessionControl({ services, resolveSafeDirectory });
  return services;
}
