import { DurableObject } from "cloudflare:workers";
import { decideRating } from "../shared/logic";
import type { Rating, RatingEvent, ServerMessage } from "../shared/types";
import { EVENT_COLS } from "./db";
import type { Env } from "./env";

export interface RatingInput {
  tastingId: number;
  beerId: number;
  userId: number;
  actorUserId: number;
  score: number | null;
  comment: string | null;
}

export type RatingResult =
  | { ok: true; changed: false }
  | { ok: true; changed: true; rating: Rating | null; event: RatingEvent }
  | { ok: false; error: string };

/**
 * One instance per tasting. Serialises rating writes (so old→new scores are
 * always consistent) and fans out updates to connected WebSockets.
 */
export class SessionRoom extends DurableObject<Env> {
  // D1 awaits are not covered by DO input gates, so queue writes explicitly.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> {
    // Clients never send anything meaningful besides auto-answered pings.
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
  }

  async broadcast(msg: ServerMessage): Promise<void> {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // dead socket; the runtime will fire close
      }
    }
  }

  applyRating(input: RatingInput): Promise<RatingResult> {
    return this.enqueue(() => this.doApplyRating(input));
  }

  /**
   * Hard-delete ratings and log lines (serialised with rating writes):
   * - beerId + userId: one cell, as if it was never rated (force remove)
   * - beerId only + deleteBeer: a removed beer with all its ratings/events
   * - userId only + deleteParticipant: a removed participant's ratings/events in this tasting
   */
  purge(input: {
    tastingId: number;
    beerId: number | null;
    userId: number | null;
    deleteBeer?: boolean;
    deleteParticipant?: boolean;
  }): Promise<number[]> {
    return this.enqueue(async () => {
      const db = this.env.DB;
      const conds = ["tasting_id = ?"];
      const args: number[] = [input.tastingId];
      if (input.beerId !== null) {
        conds.push("beer_id = ?");
        args.push(input.beerId);
      }
      if (input.userId !== null) {
        conds.push("user_id = ?");
        args.push(input.userId);
      }
      if (conds.length === 1) throw new Error("purge needs beerId and/or userId");
      const where = conds.join(" AND ");

      const stmts = [
        db.prepare(`DELETE FROM events WHERE ${where} RETURNING id`).bind(...args),
        db.prepare(`DELETE FROM ratings WHERE ${where}`).bind(...args),
      ];
      // Only rows already soft-removed may be hard-deleted.
      if (input.deleteBeer && input.beerId !== null) {
        stmts.push(
          db
            .prepare("DELETE FROM beers WHERE id = ? AND tasting_id = ? AND hidden_at IS NOT NULL")
            .bind(input.beerId, input.tastingId),
        );
      }
      if (input.deleteParticipant && input.userId !== null) {
        stmts.push(
          db
            .prepare("DELETE FROM tasting_participants WHERE user_id = ? AND tasting_id = ? AND hidden_at IS NOT NULL")
            .bind(input.userId, input.tastingId),
        );
      }
      const [deleted] = await db.batch(stmts);
      const eventIds = (deleted!.results as { id: number }[]).map((r) => r.id);
      await this.broadcast({ type: "purged", beerId: input.beerId, userId: input.userId, eventIds });
      return eventIds;
    });
  }

  /** Delete the tasting and everything in it (users are kept). Serialised with rating writes. */
  deleteTasting(tastingId: number): Promise<void> {
    return this.enqueue(async () => {
      const db = this.env.DB;
      await db.batch([
        db.prepare("DELETE FROM events WHERE tasting_id = ?").bind(tastingId),
        db.prepare("DELETE FROM ratings WHERE tasting_id = ?").bind(tastingId),
        db.prepare("DELETE FROM beers WHERE tasting_id = ?").bind(tastingId),
        db.prepare("DELETE FROM tasting_participants WHERE tasting_id = ?").bind(tastingId),
        db.prepare("DELETE FROM tastings WHERE id = ?").bind(tastingId),
      ]);
      await this.broadcast({ type: "tastingDeleted" });
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "tasting deleted");
        } catch {
          // already closed
        }
      }
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doApplyRating(input: RatingInput): Promise<RatingResult> {
    const db = this.env.DB;
    const [old, beer, user] = await Promise.all([
      db
        .prepare("SELECT score, comment, created_at FROM ratings WHERE beer_id = ? AND user_id = ?")
        .bind(input.beerId, input.userId)
        .first<{ score: number; comment: string | null; created_at: string | null }>(),
      db
        .prepare("SELECT name FROM beers WHERE id = ? AND tasting_id = ? AND hidden_at IS NULL")
        .bind(input.beerId, input.tastingId)
        .first<{ name: string }>(),
      db.prepare("SELECT nickname FROM users WHERE id = ?").bind(input.userId).first<{ nickname: string }>(),
    ]);
    if (!beer) return { ok: false, error: "Unknown beer" };
    if (!user) return { ok: false, error: "Unknown user" };

    let change;
    try {
      change = decideRating(old, input.score, input.comment);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (!change) return { ok: true, changed: false };

    const now = new Date().toISOString();
    const writeRating =
      change.score === null
        ? db.prepare("DELETE FROM ratings WHERE beer_id = ? AND user_id = ?").bind(input.beerId, input.userId)
        : db
            .prepare(
              `INSERT INTO ratings (beer_id, user_id, tasting_id, score, comment, updated_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (beer_id, user_id) DO UPDATE
                 SET score = excluded.score, comment = excluded.comment, updated_at = excluded.updated_at`,
            )
            .bind(input.beerId, input.userId, input.tastingId, change.score, change.comment, now, now);

    const insertEvent = db
      .prepare(
        `INSERT INTO events (tasting_id, type, beer_id, beer_name, user_id, nickname, actor_user_id,
                             old_score, new_score, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${EVENT_COLS}`,
      )
      .bind(
        input.tastingId,
        change.type,
        input.beerId,
        beer.name,
        input.userId,
        user.nickname,
        input.actorUserId,
        change.oldScore,
        change.score,
        change.eventComment,
        now,
      );

    const [, eventRes] = await db.batch([writeRating, insertEvent]);
    const event = (eventRes!.results as RatingEvent[])[0]!;
    const rating: Rating | null =
      change.score === null
        ? null
        : {
            beer_id: input.beerId,
            user_id: input.userId,
            score: change.score,
            comment: change.comment,
            updated_at: now,
            created_at: old?.created_at ?? now,
          };

    await this.broadcast({ type: "rating", beerId: input.beerId, userId: input.userId, rating, event });
    return { ok: true, changed: true, rating, event };
  }
}
