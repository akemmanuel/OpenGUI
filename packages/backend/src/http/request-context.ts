import type { Hono } from "hono";
import type { Actor } from "../identity/types.ts";

export type BackendRequestEnv = {
  Variables: {
    actor: Actor;
  };
};

export type BackendApp = Hono<BackendRequestEnv>;
