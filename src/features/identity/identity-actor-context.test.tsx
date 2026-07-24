import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import {
  DESKTOP_LOCAL_ACTOR,
  IdentityActorProvider,
  snapshotIdentityActor,
  useIdentityActor,
} from "./identity-actor-context";

function ActorName() {
  return <span>{useIdentityActor()?.displayName}</span>;
}

describe("identity actor context", () => {
  test("uses a neutral untranslated value for the synthetic local actor", () => {
    expect(
      renderToStaticMarkup(
        <IdentityActorProvider actor={DESKTOP_LOCAL_ACTOR}>
          <ActorName />
        </IdentityActorProvider>,
      ),
    ).toBe("<span></span>");
  });

  test("takes a role-free snapshot for transcript and queue presentation", () => {
    expect(snapshotIdentityActor(DESKTOP_LOCAL_ACTOR)).toEqual({
      type: "local",
      id: "desktop-local",
      displayName: "",
    });
  });
});
