import { Hono } from "hono";
import type { Me, Snapshot } from "../../shared/types";
import { canEditColumn, canViewTasting } from "../../shared/authz";
import {
  getTastingBySlug,
  isVisibleParticipant,
  listBeers,
  listEvents,
  listParticipants,
  listRatings,
  listTastings,
} from "../db";
import type { AppEnv } from "../env";

export const api = new Hono<AppEnv>();

api.get("/me", (c) => {
  const v = c.get("viewer");
  const me: Me = { email: v.email, realUser: v.realUser, user: v.user, impersonating: v.impersonating };
  return c.json(me);
});

api.get("/tastings", async (c) => {
  const v = c.get("viewer");
  return c.json(await listTastings(c.env.DB, v.user === null));
});

api.get("/tastings/:slug/snapshot", async (c) => {
  const v = c.get("viewer");
  const tasting = await getTastingBySlug(c.env.DB, c.req.param("slug"));
  if (!tasting || !canViewTasting(v, tasting)) return c.json({ error: "Not found" }, 404);

  const [beers, participants, ratings, events] = await Promise.all([
    listBeers(c.env.DB, tasting.id, false),
    listParticipants(c.env.DB, tasting.id, false),
    listRatings(c.env.DB, tasting.id),
    listEvents(c.env.DB, tasting.id),
  ]);
  const snapshot: Snapshot = { tasting, beers, participants, ratings, events };
  return c.json(snapshot);
});

api.get("/tastings/:slug/events", async (c) => {
  const v = c.get("viewer");
  const tasting = await getTastingBySlug(c.env.DB, c.req.param("slug"));
  if (!tasting || !canViewTasting(v, tasting)) return c.json({ error: "Not found" }, 404);
  const before = Number(c.req.query("before")) || undefined;
  return c.json(await listEvents(c.env.DB, tasting.id, before));
});

api.post("/tastings/:slug/ratings", async (c) => {
  const v = c.get("viewer");
  const tasting = await getTastingBySlug(c.env.DB, c.req.param("slug"));
  if (!tasting || !canViewTasting(v, tasting)) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ beerId: unknown; userId: unknown; score: unknown; comment?: unknown }>();
  const beerId = Number(body.beerId);
  const userId = Number(body.userId);
  const score = body.score === null ? null : Number(body.score);
  const comment = typeof body.comment === "string" ? body.comment.slice(0, 500) : null;
  if (!Number.isInteger(beerId) || !Number.isInteger(userId)) return c.json({ error: "Bad request" }, 400);
  if (score !== null && (!Number.isInteger(score) || score < 1 || score > 10)) {
    return c.json({ error: "Score must be 1-10" }, 400);
  }

  const visible = await isVisibleParticipant(c.env.DB, tasting.id, userId);
  if (!canEditColumn(v, tasting, userId, visible)) return c.json({ error: "Forbidden" }, 403);

  const room = c.env.ROOM.get(c.env.ROOM.idFromName(String(tasting.id)));
  // Impersonated edits are attributed to the column owner; actor keeps the real person.
  const actorUserId = v.realUser!.id;
  const result = await room.applyRating({ tastingId: tasting.id, beerId, userId, actorUserId, score, comment });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result);
});

export const ws = new Hono<AppEnv>();

ws.get("/tastings/:slug", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const v = c.get("viewer");
  const tasting = await getTastingBySlug(c.env.DB, c.req.param("slug"));
  if (!tasting || !canViewTasting(v, tasting)) return c.text("Not found", 404);
  const room = c.env.ROOM.get(c.env.ROOM.idFromName(String(tasting.id)));
  return room.fetch(c.req.raw);
});

