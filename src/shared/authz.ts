import type { Tasting, User } from "./types";

/** Anything carrying the resolved identity (server Viewer or client Me). */
export interface Identity {
  realUser: User | null;
  user: User | null;
  impersonating: boolean;
}

/** Full admin rights: real admin who is not currently viewing as someone else. */
export function isAdmin(v: Identity): boolean {
  return v.realUser?.role === "admin" && !v.impersonating;
}

export function isRegistered(v: Identity): boolean {
  return v.user !== null;
}

/** Active tasting is public; old tastings are for registered users only. */
export function canViewTasting(v: Identity, t: Pick<Tasting, "is_active">): boolean {
  return t.is_active === 1 || isRegistered(v);
}

/**
 * May the viewer set ratings in `targetUserId`'s column? The target must be a
 * visible participant. Users edit only their own column in the active tasting;
 * admins edit anything.
 */
export function canEditColumn(
  v: Identity,
  t: Pick<Tasting, "is_active">,
  targetUserId: number,
  targetIsVisibleParticipant: boolean,
): boolean {
  if (!v.user || !targetIsVisibleParticipant) return false;
  if (isAdmin(v)) return true;
  return v.user.id === targetUserId && t.is_active === 1;
}
