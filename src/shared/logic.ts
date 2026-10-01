import type { EventType, Rating } from "./types";

export interface RatingChange {
  type: EventType;
  /** Resulting rating state; null means the rating is removed. */
  score: number | null;
  comment: string | null;
  oldScore: number | null;
  /** Comment to record on the event (only what was newly written). */
  eventComment: string | null;
}

/**
 * Decide what a rating submission does. A blank comment never overwrites an
 * existing one. Returns null when nothing changes.
 */
export function decideRating(
  old: Pick<Rating, "score" | "comment"> | null,
  score: number | null,
  rawComment: string | null | undefined,
): RatingChange | null {
  const comment = rawComment?.trim() ? rawComment.trim() : null;

  if (score === null) {
    if (!old) return null;
    return { type: "cleared", score: null, comment: null, oldScore: old.score, eventComment: null };
  }
  if (!Number.isInteger(score) || score < 1 || score > 10) {
    throw new RangeError("score must be an integer 1-10");
  }
  if (!old) {
    return { type: "rated", score, comment, oldScore: null, eventComment: comment };
  }
  const nextComment = comment ?? old.comment;
  const commentChanged = comment !== null && comment !== old.comment;
  if (old.score !== score) {
    return {
      type: "changed",
      score,
      comment: nextComment,
      oldScore: old.score,
      eventComment: commentChanged ? comment : null,
    };
  }
  if (commentChanged) {
    return { type: "commented", score, comment, oldScore: old.score, eventComment: comment };
  }
  return null;
}

export function average(scores: number[]): number | null {
  if (scores.length === 0) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

export interface LeaderboardEntry {
  beerId: number;
  name: string;
  avg: number;
  votes: number;
  rank: number;
}

/**
 * Rank rated beers by avg desc, votes desc, name asc. Beers with identical
 * (avg, votes) share a rank (competition ranking: 1, 1, 3).
 */
export function leaderboard(
  beers: { id: number; name: string }[],
  scoresByBeer: Map<number, number[]>,
): LeaderboardEntry[] {
  const rows = beers
    .map((b) => {
      const scores = scoresByBeer.get(b.id) ?? [];
      return { beerId: b.id, name: b.name, avg: average(scores) ?? 0, votes: scores.length, rank: 0 };
    })
    .filter((r) => r.votes > 0)
    .sort((a, b) => b.avg - a.avg || b.votes - a.votes || a.name.localeCompare(b.name));

  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.rank = prev && Math.abs(prev.avg - r.avg) < 1e-9 && prev.votes === r.votes ? prev.rank : i + 1;
  });
  return rows;
}

export interface ConsumedEntry {
  userId: number;
  nickname: string;
  count: number;
  /** When the user reached `count`: the latest first-rating time among their rated beers. */
  reachedAt: string;
  rank: number;
}

/**
 * Beers "consumed" per participant (a beer counts once it has a rating). Sorted by count desc;
 * ties go to whoever reached that count first. Participants with 0 are omitted.
 */
export function consumedBoard(
  participants: { user_id: number; nickname: string }[],
  beerIds: Set<number>,
  ratings: Iterable<{ beer_id: number; user_id: number; created_at: string }>,
): ConsumedEntry[] {
  const byUser = new Map<number, { count: number; reachedAt: string }>();
  for (const r of ratings) {
    if (!beerIds.has(r.beer_id)) continue;
    const cur = byUser.get(r.user_id) ?? { count: 0, reachedAt: "" };
    cur.count++;
    if (r.created_at > cur.reachedAt) cur.reachedAt = r.created_at;
    byUser.set(r.user_id, cur);
  }
  const rows = participants
    .flatMap((p) => {
      const c = byUser.get(p.user_id);
      return c ? [{ userId: p.user_id, nickname: p.nickname, count: c.count, reachedAt: c.reachedAt, rank: 0 }] : [];
    })
    .sort((a, b) => b.count - a.count || a.reachedAt.localeCompare(b.reachedAt) || a.nickname.localeCompare(b.nickname));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}
