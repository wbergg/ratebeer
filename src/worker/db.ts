import type { Beer, Participant, Rating, RatingEvent, Tasting } from "../shared/types";

export const EVENT_PAGE = 50;

const BEER_COLS = "id, tasting_id, name, size_ml, abv, image_url, position, hidden_at";
const EVENT_COLS =
  "id, tasting_id, type, beer_id, beer_name, user_id, nickname, old_score, new_score, comment, created_at";

export const getTastingBySlug = (db: D1Database, slug: string) =>
  db.prepare("SELECT id, slug, name, is_active FROM tastings WHERE slug = ?").bind(slug).first<Tasting>();

export const getTastingById = (db: D1Database, id: number) =>
  db.prepare("SELECT id, slug, name, is_active FROM tastings WHERE id = ?").bind(id).first<Tasting>();

export async function listTastings(db: D1Database, activeOnly: boolean): Promise<Tasting[]> {
  const sql = activeOnly
    ? "SELECT id, slug, name, is_active FROM tastings WHERE is_active = 1"
    : "SELECT id, slug, name, is_active FROM tastings ORDER BY is_active DESC, created_at DESC";
  return (await db.prepare(sql).all<Tasting>()).results;
}

export async function listBeers(db: D1Database, tastingId: number, includeHidden: boolean): Promise<Beer[]> {
  const where = includeHidden ? "" : " AND hidden_at IS NULL";
  return (
    await db
      .prepare(`SELECT ${BEER_COLS} FROM beers WHERE tasting_id = ?${where} ORDER BY position, id`)
      .bind(tastingId)
      .all<Beer>()
  ).results;
}

export async function listParticipants(
  db: D1Database,
  tastingId: number,
  includeHidden: boolean,
): Promise<Participant[]> {
  const where = includeHidden ? "" : " AND p.hidden_at IS NULL";
  return (
    await db
      .prepare(
        `SELECT p.user_id, u.nickname, p.position, p.hidden_at
           FROM tasting_participants p JOIN users u ON u.id = p.user_id
          WHERE p.tasting_id = ?${where}
          ORDER BY p.position, u.nickname`,
      )
      .bind(tastingId)
      .all<Participant>()
  ).results;
}

export async function listRatings(db: D1Database, tastingId: number): Promise<Rating[]> {
  return (
    await db
      .prepare("SELECT beer_id, user_id, score, comment, updated_at, created_at FROM ratings WHERE tasting_id = ?")
      .bind(tastingId)
      .all<Rating>()
  ).results;
}

export async function listEvents(db: D1Database, tastingId: number, beforeId?: number): Promise<RatingEvent[]> {
  const stmt = beforeId
    ? db
        .prepare(`SELECT ${EVENT_COLS} FROM events WHERE tasting_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
        .bind(tastingId, beforeId, EVENT_PAGE)
    : db
        .prepare(`SELECT ${EVENT_COLS} FROM events WHERE tasting_id = ? ORDER BY id DESC LIMIT ?`)
        .bind(tastingId, EVENT_PAGE);
  return (await stmt.all<RatingEvent>()).results;
}

export const isVisibleParticipant = async (db: D1Database, tastingId: number, userId: number) =>
  (await db
    .prepare("SELECT 1 AS ok FROM tasting_participants WHERE tasting_id = ? AND user_id = ? AND hidden_at IS NULL")
    .bind(tastingId, userId)
    .first()) !== null;

export { EVENT_COLS };
