import { describe, expect, it } from "vitest";
import { average, consumedBoard, decideRating, leaderboard } from "../src/shared/logic";

describe("decideRating", () => {
  it("first rating", () => {
    expect(decideRating(null, 7, "nice")).toMatchObject({ type: "rated", score: 7, comment: "nice", oldScore: null, eventComment: "nice" });
  });
  it("first rating without comment", () => {
    expect(decideRating(null, 7, "   ")).toMatchObject({ type: "rated", comment: null, eventComment: null });
  });
  it("changed score keeps old comment when blank", () => {
    expect(decideRating({ score: 7, comment: "old" }, 8, "")).toMatchObject({
      type: "changed", score: 8, oldScore: 7, comment: "old", eventComment: null,
    });
  });
  it("changed score with new comment", () => {
    expect(decideRating({ score: 7, comment: "old" }, 5, "meh")).toMatchObject({ type: "changed", comment: "meh", eventComment: "meh" });
  });
  it("changed score with unchanged (prefilled) comment does not repeat it on the event", () => {
    expect(decideRating({ score: 7, comment: "old" }, 8, "old")).toMatchObject({ type: "changed", comment: "old", eventComment: null });
  });
  it("comment-only change", () => {
    expect(decideRating({ score: 7, comment: "old" }, 7, "new")).toMatchObject({ type: "commented", score: 7, comment: "new" });
  });
  it("no-op: same score, blank or identical comment", () => {
    expect(decideRating({ score: 7, comment: "x" }, 7, "")).toBeNull();
    expect(decideRating({ score: 7, comment: "x" }, 7, " x ")).toBeNull();
  });
  it("clear", () => {
    expect(decideRating({ score: 4, comment: "x" }, null, "")).toMatchObject({ type: "cleared", score: null, oldScore: 4 });
    expect(decideRating(null, null, "")).toBeNull();
  });
  it("rejects out-of-range scores", () => {
    expect(() => decideRating(null, 0, null)).toThrow();
    expect(() => decideRating(null, 11, null)).toThrow();
    expect(() => decideRating(null, 5.5, null)).toThrow();
  });
});

describe("average", () => {
  it("5, 6, 7 → 6", () => expect(average([5, 6, 7])).toBe(6));
  it("empty → null", () => expect(average([])).toBeNull());
});

describe("leaderboard", () => {
  const beers = [
    { id: 1, name: "Alpha" },
    { id: 2, name: "Bravo" },
    { id: 3, name: "Charlie" },
    { id: 4, name: "Delta" },
    { id: 5, name: "Unrated" },
  ];
  it("sorts by avg, then votes, shares ranks on exact ties, skips unrated", () => {
    const scores = new Map([
      [1, [8, 8]], // avg 8, 2 votes
      [2, [8, 8]], // tie with Alpha
      [3, [8]], // avg 8, 1 vote → behind
      [4, [9]], // top
    ]);
    const rows = leaderboard(beers, scores);
    expect(rows.map((r) => [r.name, r.rank])).toEqual([
      ["Delta", 1],
      ["Alpha", 2],
      ["Bravo", 2],
      ["Charlie", 4],
    ]);
  });
});

describe("consumedBoard", () => {
  const parts = [
    { user_id: 1, nickname: "anna" },
    { user_id: 2, nickname: "bob" },
    { user_id: 3, nickname: "cleo" },
    { user_id: 4, nickname: "dan" },
  ];
  const r = (beer_id: number, user_id: number, created_at: string) => ({ beer_id, user_id, created_at });
  it("orders by count, then earliest to reach it; hides 0; ignores hidden beers", () => {
    const rows = consumedBoard(parts, new Set([10, 11, 12]), [
      r(10, 1, "2026-10-01T10:00:00Z"),
      r(11, 1, "2026-10-01T10:30:00Z"), // anna reached 2 at 10:30
      r(10, 2, "2026-10-01T10:05:00Z"),
      r(12, 2, "2026-10-01T10:20:00Z"), // bob reached 2 at 10:20 → ahead of anna
      r(10, 3, "2026-10-01T09:00:00Z"),
      r(99, 3, "2026-10-01T09:01:00Z"), // hidden/unknown beer: not counted
    ]);
    expect(rows.map((x) => [x.nickname, x.count, x.rank])).toEqual([
      ["bob", 2, 1],
      ["anna", 2, 2],
      ["cleo", 1, 3],
    ]);
  });
});
