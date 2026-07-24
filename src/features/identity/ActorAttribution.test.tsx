import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { ActorAttributionLabel, actorAttributionText } from "./ActorAttribution";

const currentActor = { type: "user" as const, id: "user-1", displayName: "alice" };

describe("actor attribution", () => {
  test("labels the current actor with the translated You copy", () => {
    expect(actorAttributionText(currentActor, currentActor, "Du")).toBe("Du");
    expect(
      renderToStaticMarkup(
        <ActorAttributionLabel actor={currentActor} currentActor={currentActor} youLabel="Du" />,
      ),
    ).toContain(">Du</span>");
  });

  test("uses the persisted display name for another user or API key", () => {
    expect(
      actorAttributionText(
        { type: "api_key", id: "key-1", displayName: "Release bot" },
        currentActor,
        "You",
      ),
    ).toBe("Release bot");
  });

  test("leaves legacy actorless content unlabeled", () => {
    expect(actorAttributionText(undefined, currentActor, "You")).toBeNull();
    expect(
      renderToStaticMarkup(<ActorAttributionLabel currentActor={currentActor} youLabel="You" />),
    ).toBe("");
  });

  test("uses translated You instead of a synthetic local display name", () => {
    const local = { type: "local" as const, id: "desktop-local", displayName: "" };
    expect(actorAttributionText(local, local, "Tú")).toBe("Tú");
  });
});
