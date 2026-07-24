import { afterEach, describe, expect, test } from "vite-plus/test";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet } from "@/lib/persistence/storage";
import { polyfillLocalStorage } from "@/lib/__tests__/setup";
import {
  buildSetupModelConnection,
  persistSetupCompletion,
  saveSetupModelConnection,
  selectSetupFolder,
} from "./SetupWizard";

polyfillLocalStorage();

afterEach(() => localStorage.clear());

describe("Setup wizard completion", () => {
  test("uses the Host folder browser in Web instead of the unavailable desktop picker", async () => {
    let desktopPickerCalls = 0;
    const selected = await selectSetupFolder(
      {
        runtime: { isElectron: false },
        dialog: {
          openDirectory: async () => {
            desktopPickerCalls += 1;
            return null;
          },
        },
      },
      "/srv/current",
      async (initialPath) => {
        expect(initialPath).toBe("/srv/current");
        return "/srv/selected";
      },
    );

    expect(selected).toBe("/srv/selected");
    expect(desktopPickerCalls).toBe(0);
  });

  test("normalizes a model connection before sending it to the Host", () => {
    expect(
      buildSetupModelConnection({
        baseUrl: "  https://models.example/v1/  ",
        apiKey: "  secret  ",
        modelId: "  model-a  ",
      }),
    ).toEqual({
      id: "default",
      label: "Default",
      baseUrl: "https://models.example/v1/",
      apiKey: "secret",
      modelIds: ["model-a"],
    });
    expect(
      buildSetupModelConnection({ baseUrl: " ", apiKey: "secret", modelId: "model-a" }),
    ).toBeNull();
    expect(
      buildSetupModelConnection({ baseUrl: "https://models.example", apiKey: "", modelId: " " }),
    ).toBeNull();
  });

  test("refreshes the model catalog after setup saves a connection", async () => {
    const events: string[] = [];
    await saveSetupModelConnection(
      {
        upsertModelConnection: async () => {
          events.push("saved");
          return {} as never;
        },
      },
      { baseUrl: "https://models.example/v1", apiKey: "key", modelId: "model-a" },
      async () => {
        events.push("refreshed");
      },
    );
    expect(events).toEqual(["saved", "refreshed"]);
  });

  test("marks setup complete and only stores a non-empty default Project directory", () => {
    persistSetupCompletion("  /work/my project  ");
    expect(storageGet(STORAGE_KEYS.SETUP_COMPLETE)).toBe("true");
    expect(storageGet(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY)).toBe("/work/my project");

    localStorage.clear();
    persistSetupCompletion("  ");
    expect(storageGet(STORAGE_KEYS.SETUP_COMPLETE)).toBe("true");
    expect(storageGet(STORAGE_KEYS.DEFAULT_CHAT_DIRECTORY)).toBeNull();
  });
});
