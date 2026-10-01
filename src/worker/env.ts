import type { SessionRoom } from "./room";
import type { User } from "../shared/types";

export interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace<SessionRoom>;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

export interface Viewer {
  email: string | null;
  tokenHash: string | null;
  realUser: User | null;
  /** Effective user: the impersonated user while impersonating, else realUser. */
  user: User | null;
  impersonating: boolean;
}

export type AppEnv = { Bindings: Env; Variables: { viewer: Viewer } };
