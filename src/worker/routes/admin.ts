import { Hono } from "hono";
import type { Role, ServerMessage } from "../../shared/types";
import { isAdmin } from "../../shared/authz";
import { getTastingById, listBeers, listParticipants, listTastings } from "../db";
import type { AppEnv, Env } from "../env";

export const admin = new Hono<AppEnv>();

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES: Role[] = ["user", "admin"];
// Numeric path ids only; anything else falls through to the JSON 404.
const ID = "{[0-9]{1,9}}";

const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

const room = (env: Env, tastingId: number) => env.ROOM.get(env.ROOM.idFromName(String(tastingId)));
const broadcast = (env: Env, tastingId: number, msg: ServerMessage) => room(env, tastingId).broadcast(msg);

const pushBeers = async (env: Env, tastingId: number) =>
  broadcast(env, tastingId, { type: "beers", beers: await listBeers(env.DB, tastingId, false) });
const pushParticipants = async (env: Env, tastingId: number) =>
  broadcast(env, tastingId, { type: "participants", participants: await listParticipants(env.DB, tastingId, false) });

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const numOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

function parseBeer(b: Record<string, unknown>) {
  const name = str(b.name);
  const size_ml = numOrNull(b.size_ml);
  const abv = numOrNull(b.abv);
  const image_url = str(b.image_url, 1000) || null;
  if (!name) return { error: "Name is required" } as const;
  if (size_ml !== null && (!Number.isInteger(size_ml) || size_ml <= 0 || size_ml > 100000))
    return { error: "Size must be a whole number of ml" } as const;
  if (abv !== null && (!Number.isFinite(abv) || abv < 0 || abv > 100)) return { error: "ABV must be 0-100" } as const;
  if (image_url && !/^https:\/\//i.test(image_url)) return { error: "Image URL must start with https://" } as const;
  return { name, size_ml, abv, image_url } as const;
}

// Impersonation is controlled by the real admin, even while impersonating.
admin.post("/impersonate", async (c) => {
  const v = c.get("viewer");
  if (v.realUser?.role !== "admin" || !v.tokenHash) return c.json({ error: "Forbidden" }, 403);
  const { userId } = await c.req.json<{ userId: unknown }>();
  if (userId !== null && !isId(userId)) return c.json({ error: "Bad user id" }, 400);
  const target = userId === null || userId === v.realUser.id ? null : userId;
  if (target !== null) {
    const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(target).first();
    if (!exists) return c.json({ error: "Unknown user" }, 404);
  }
  await c.env.DB.prepare("UPDATE auth_sessions SET impersonate_user_id = ? WHERE token_hash = ?")
    .bind(target, v.tokenHash)
    .run();
  return c.json({ ok: true });
});

admin.use("*", async (c, next) => {
  if (!isAdmin(c.get("viewer"))) return c.json({ error: "Forbidden" }, 403);
  return next();
});

// ---- users ----

admin.get("/users", async (c) =>
  c.json((await c.env.DB.prepare("SELECT id, email, nickname, role FROM users ORDER BY nickname").all()).results),
);

admin.post("/users", async (c) => {
  const b = await c.req.json<Record<string, unknown>>();
  const email = str(b.email).toLowerCase();
  const nickname = str(b.nickname, 40);
  const role = b.role as Role;
  if (!EMAIL_RE.test(email) || !nickname || !ROLES.includes(role)) return c.json({ error: "Invalid user" }, 400);
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO users (email, nickname, role) VALUES (?, ?, ?) RETURNING id, email, nickname, role",
    )
      .bind(email, nickname, role)
      .first();
    return c.json(row, 201);
  } catch {
    return c.json({ error: "Email or nickname already in use" }, 409);
  }
});

admin.patch(`/users/:id${ID}`, async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<Record<string, unknown>>();
  const email = str(b.email).toLowerCase();
  const nickname = str(b.nickname, 40);
  const role = b.role as Role;
  if (!EMAIL_RE.test(email) || !nickname || !ROLES.includes(role)) return c.json({ error: "Invalid user" }, 400);
  if (id === c.get("viewer").realUser!.id && role !== "admin") {
    return c.json({ error: "You cannot remove your own admin role" }, 400);
  }
  try {
    await c.env.DB.prepare("UPDATE users SET email = ?, nickname = ?, role = ? WHERE id = ?")
      .bind(email, nickname, role, id)
      .run();
  } catch {
    return c.json({ error: "Email or nickname already in use" }, 409);
  }
  const tastings = await c.env.DB.prepare("SELECT tasting_id FROM tasting_participants WHERE user_id = ?")
    .bind(id)
    .all<{ tasting_id: number }>();
  await Promise.all(tastings.results.map((t) => pushParticipants(c.env, t.tasting_id)));
  return c.json({ ok: true });
});

admin.delete(`/users/:id${ID}`, async (c) => {
  const id = Number(c.req.param("id"));
  if (id === c.get("viewer").realUser!.id) return c.json({ error: "You cannot delete yourself" }, 400);
  const used = await c.env.DB.prepare("SELECT 1 FROM ratings WHERE user_id = ? UNION SELECT 1 FROM events WHERE user_id = ? LIMIT 1")
    .bind(id, id)
    .first();
  if (used) return c.json({ error: "User has ratings; remove them from the roster instead" }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM tasting_participants WHERE user_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

// ---- tastings ----

admin.get("/tastings", async (c) => c.json(await listTastings(c.env.DB, false)));

admin.post("/tastings", async (c) => {
  const b = await c.req.json<Record<string, unknown>>();
  const name = str(b.name, 100);
  const slug = str(b.slug, 40).toLowerCase();
  if (!name || !SLUG_RE.test(slug)) return c.json({ error: "Name and a slug (a-z, 0-9, -) are required" }, 400);
  try {
    const row = await c.env.DB.prepare("INSERT INTO tastings (slug, name) VALUES (?, ?) RETURNING id, slug, name, is_active")
      .bind(slug, name)
      .first();
    return c.json(row, 201);
  } catch {
    return c.json({ error: "Slug already in use" }, 409);
  }
});

admin.patch(`/tastings/:id${ID}`, async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<Record<string, unknown>>();
  const name = str(b.name, 100);
  if (!name) return c.json({ error: "Name is required" }, 400);
  await c.env.DB.prepare("UPDATE tastings SET name = ? WHERE id = ?").bind(name, id).run();
  const t = await getTastingById(c.env.DB, id);
  if (t) await broadcast(c.env, id, { type: "tasting", tasting: t });
  return c.json({ ok: true });
});

admin.post(`/tastings/:id${ID}/activate`, async (c) => {
  const id = Number(c.req.param("id"));
  const { active } = await c.req.json<{ active: unknown }>();
  if (typeof active !== "boolean") return c.json({ error: "active must be true or false" }, 400);
  if (!(await getTastingById(c.env.DB, id))) return c.json({ error: "Not found" }, 404);
  const prev = await c.env.DB.prepare("SELECT id FROM tastings WHERE is_active = 1").first<{ id: number }>();
  if (active) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE tastings SET is_active = 0 WHERE is_active = 1"),
      c.env.DB.prepare("UPDATE tastings SET is_active = 1 WHERE id = ?").bind(id),
    ]);
  } else {
    await c.env.DB.prepare("UPDATE tastings SET is_active = 0 WHERE id = ?").bind(id).run();
  }
  const affected = new Set([id, prev?.id].filter((x): x is number => x !== undefined));
  for (const tid of affected) {
    const t = await getTastingById(c.env.DB, tid);
    if (t) await broadcast(c.env, tid, { type: "tasting", tasting: t });
  }
  return c.json({ ok: true });
});

admin.delete(`/tastings/:id${ID}`, async (c) => {
  const id = Number(c.req.param("id"));
  const t = await getTastingById(c.env.DB, id);
  if (!t) return c.json({ error: "Not found" }, 404);
  await room(c.env, id).deleteTasting(id);
  return c.json({ ok: true });
});

// ---- participants ----

admin.get(`/tastings/:id${ID}/participants`, async (c) =>
  c.json(await listParticipants(c.env.DB, Number(c.req.param("id")), true)),
);

admin.post(`/tastings/:id${ID}/participants`, async (c) => {
  const tastingId = Number(c.req.param("id"));
  const { userId } = await c.req.json<{ userId: unknown }>();
  if (!isId(userId)) return c.json({ error: "Bad user id" }, 400);
  const [tasting, user] = await Promise.all([
    getTastingById(c.env.DB, tastingId),
    c.env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(userId).first(),
  ]);
  if (!tasting) return c.json({ error: "Not found" }, 404);
  if (!user) return c.json({ error: "Unknown user" }, 404);
  await c.env.DB.prepare(
    `INSERT INTO tasting_participants (tasting_id, user_id, position)
     VALUES (?1, ?2, (SELECT COALESCE(MAX(position), -1) + 1 FROM tasting_participants WHERE tasting_id = ?1))
     ON CONFLICT (tasting_id, user_id) DO UPDATE SET hidden_at = NULL`,
  )
    .bind(tastingId, userId)
    .run();
  await pushParticipants(c.env, tastingId);
  return c.json({ ok: true });
});

admin.patch(`/tastings/:id${ID}/participants/:userId${ID}`, async (c) => {
  const tastingId = Number(c.req.param("id"));
  const { hidden } = await c.req.json<{ hidden: boolean }>();
  await c.env.DB.prepare("UPDATE tasting_participants SET hidden_at = ? WHERE tasting_id = ? AND user_id = ?")
    .bind(hidden ? new Date().toISOString() : null, tastingId, Number(c.req.param("userId")))
    .run();
  await pushParticipants(c.env, tastingId);
  return c.json({ ok: true });
});

admin.put(`/tastings/:id${ID}/participants/order`, async (c) => {
  const tastingId = Number(c.req.param("id"));
  const { ids } = await c.req.json<{ ids: unknown }>();
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isId)) return c.json({ error: "ids required" }, 400);
  await c.env.DB.batch(
    ids.map((uid, i) =>
      c.env.DB.prepare("UPDATE tasting_participants SET position = ? WHERE tasting_id = ? AND user_id = ?").bind(
        i,
        tastingId,
        uid,
      ),
    ),
  );
  await pushParticipants(c.env, tastingId);
  return c.json({ ok: true });
});

// ---- beers ----

admin.get(`/tastings/:id${ID}/beers`, async (c) => c.json(await listBeers(c.env.DB, Number(c.req.param("id")), true)));

admin.post(`/tastings/:id${ID}/beers`, async (c) => {
  const tastingId = Number(c.req.param("id"));
  const beer = parseBeer(await c.req.json());
  if ("error" in beer) return c.json(beer, 400);
  if (!(await getTastingById(c.env.DB, tastingId))) return c.json({ error: "Not found" }, 404);
  await c.env.DB.prepare(
    `INSERT INTO beers (tasting_id, name, size_ml, abv, image_url, position)
     VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(position), -1) + 1 FROM beers WHERE tasting_id = ?1))`,
  )
    .bind(tastingId, beer.name, beer.size_ml, beer.abv, beer.image_url)
    .run();
  await pushBeers(c.env, tastingId);
  return c.json({ ok: true }, 201);
});

admin.patch(`/tastings/:id${ID}/beers/:beerId${ID}`, async (c) => {
  const tastingId = Number(c.req.param("id"));
  const beerId = Number(c.req.param("beerId"));
  const b = await c.req.json<Record<string, unknown>>();
  if ("hidden" in b) {
    await c.env.DB.prepare("UPDATE beers SET hidden_at = ? WHERE id = ? AND tasting_id = ?")
      .bind(b.hidden ? new Date().toISOString() : null, beerId, tastingId)
      .run();
  } else {
    const beer = parseBeer(b);
    if ("error" in beer) return c.json(beer, 400);
    await c.env.DB.prepare(
      "UPDATE beers SET name = ?, size_ml = ?, abv = ?, image_url = ? WHERE id = ? AND tasting_id = ?",
    )
      .bind(beer.name, beer.size_ml, beer.abv, beer.image_url, beerId, tastingId)
      .run();
  }
  await pushBeers(c.env, tastingId);
  return c.json({ ok: true });
});

admin.put(`/tastings/:id${ID}/beers/order`, async (c) => {
  const tastingId = Number(c.req.param("id"));
  const { ids } = await c.req.json<{ ids: unknown }>();
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isId)) return c.json({ error: "ids required" }, 400);
  await c.env.DB.batch(
    ids.map((bid, i) =>
      c.env.DB.prepare("UPDATE beers SET position = ? WHERE id = ? AND tasting_id = ?").bind(i, bid, tastingId),
    ),
  );
  await pushBeers(c.env, tastingId);
  return c.json({ ok: true });
});

// ---- events ----

admin.delete(`/events/:id${ID}`, async (c) => {
  const id = Number(c.req.param("id"));
  const ev = await c.env.DB.prepare("DELETE FROM events WHERE id = ? RETURNING tasting_id")
    .bind(id)
    .first<{ tasting_id: number }>();
  if (!ev) return c.json({ error: "Not found" }, 404);
  await broadcast(c.env, ev.tasting_id, { type: "eventRemoved", id });
  return c.json({ ok: true });
});

// Force remove: clears the rating this event belongs to and all log lines for that cell.
admin.post(`/events/:id${ID}/force`, async (c) => {
  const ev = await c.env.DB.prepare("SELECT tasting_id, beer_id, user_id FROM events WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .first<{ tasting_id: number; beer_id: number; user_id: number }>();
  if (!ev) return c.json({ error: "Not found" }, 404);
  const removed = await room(c.env, ev.tasting_id).purge({
    tastingId: ev.tasting_id,
    beerId: ev.beer_id,
    userId: ev.user_id,
  });
  return c.json({ ok: true, removedEvents: removed.length });
});

// ---- permanent deletion of soft-removed beers / participants ----

admin.delete(`/tastings/:id${ID}/beers/:beerId${ID}`, async (c) => {
  const tastingId = Number(c.req.param("id"));
  const beerId = Number(c.req.param("beerId"));
  const beer = await c.env.DB.prepare("SELECT hidden_at FROM beers WHERE id = ? AND tasting_id = ?")
    .bind(beerId, tastingId)
    .first<{ hidden_at: string | null }>();
  if (!beer) return c.json({ error: "Not found" }, 404);
  if (!beer.hidden_at) return c.json({ error: "Remove the beer first, then delete it permanently" }, 409);
  const removed = await room(c.env, tastingId).purge({ tastingId, beerId, userId: null, deleteBeer: true });
  return c.json({ ok: true, removedEvents: removed.length });
});

admin.delete(`/tastings/:id${ID}/participants/:userId${ID}`, async (c) => {
  const tastingId = Number(c.req.param("id"));
  const userId = Number(c.req.param("userId"));
  const part = await c.env.DB.prepare("SELECT hidden_at FROM tasting_participants WHERE user_id = ? AND tasting_id = ?")
    .bind(userId, tastingId)
    .first<{ hidden_at: string | null }>();
  if (!part) return c.json({ error: "Not found" }, 404);
  if (!part.hidden_at) return c.json({ error: "Remove the participant first, then delete permanently" }, 409);
  const removed = await room(c.env, tastingId).purge({ tastingId, beerId: null, userId, deleteParticipant: true });
  return c.json({ ok: true, removedEvents: removed.length });
});
