export type Role = "user" | "admin";

/** Event log page size (initial snapshot and each "Load more"). */
export const EVENT_PAGE = 50;

export interface User {
  id: number;
  email: string;
  nickname: string;
  role: Role;
}

export interface Tasting {
  id: number;
  slug: string;
  name: string;
  is_active: number;
}

export interface Beer {
  id: number;
  tasting_id: number;
  name: string;
  size_ml: number | null;
  abv: number | null;
  image_url: string | null;
  position: number;
  hidden_at: string | null;
}

export interface Participant {
  user_id: number;
  nickname: string;
  position: number;
  hidden_at: string | null;
}

export interface Rating {
  beer_id: number;
  user_id: number;
  score: number;
  comment: string | null;
  updated_at: string;
  /** First time this beer was rated by this user (unchanged by edits). */
  created_at: string;
}

export type EventType = "rated" | "changed" | "cleared" | "commented";

export interface RatingEvent {
  id: number;
  tasting_id: number;
  type: EventType;
  beer_id: number;
  beer_name: string;
  user_id: number;
  nickname: string;
  old_score: number | null;
  new_score: number | null;
  comment: string | null;
  created_at: string;
}

export interface Me {
  email: string | null;
  /** The real signed-in user (null if not registered). */
  realUser: User | null;
  /** The user whose permissions apply (impersonated user if impersonating). */
  user: User | null;
  impersonating: boolean;
}

export interface Snapshot {
  tasting: Tasting;
  beers: Beer[];
  participants: Participant[];
  ratings: Rating[];
  events: RatingEvent[];
}

export type ServerMessage =
  | { type: "rating"; beerId: number; userId: number; rating: Rating | null; event: RatingEvent }
  | { type: "beers"; beers: Beer[] }
  | { type: "participants"; participants: Participant[] }
  | { type: "tasting"; tasting: Tasting }
  | { type: "eventRemoved"; id: number }
  /** The tasting itself was deleted; clients should navigate away. */
  | { type: "tastingDeleted" }
  /**
   * Admin hard-deleted data: drop ratings matching beerId and/or userId, and the listed log lines.
   * (Force-removed cell: both set. Deleted beer: beerId only. Deleted participant: userId only.)
   */
  | { type: "purged"; beerId: number | null; userId: number | null; eventIds: number[] };
