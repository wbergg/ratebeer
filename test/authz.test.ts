import { describe, expect, it } from "vitest";
import { canEditColumn, canViewTasting, type Identity } from "../src/shared/authz";
import type { User } from "../src/shared/types";

const anna: User = { id: 1, email: "anna@x", nickname: "anna", role: "user" };
const bob: User = { id: 2, email: "bob@x", nickname: "bob", role: "user" };
const boss: User = { id: 9, email: "boss@x", nickname: "boss", role: "admin" };

const anon: Identity = { realUser: null, user: null, impersonating: false };
const unregistered: Identity = anon; // signed in but not in users table resolves the same
const asAnna: Identity = { realUser: anna, user: anna, impersonating: false };
const asAdmin: Identity = { realUser: boss, user: boss, impersonating: false };
const adminAsAnna: Identity = { realUser: boss, user: anna, impersonating: true };

const active = { is_active: 1 };
const old = { is_active: 0 };

describe("canViewTasting", () => {
  it("active is public, old is registered-only", () => {
    expect(canViewTasting(anon, active)).toBe(true);
    expect(canViewTasting(anon, old)).toBe(false);
    expect(canViewTasting(asAnna, old)).toBe(true);
  });
});

describe("canEditColumn", () => {
  it("anonymous / unregistered cannot edit", () => {
    expect(canEditColumn(anon, active, anna.id, true)).toBe(false);
    expect(canEditColumn(unregistered, active, anna.id, true)).toBe(false);
  });
  it("user edits own column only, only in active tasting", () => {
    expect(canEditColumn(asAnna, active, anna.id, true)).toBe(true);
    expect(canEditColumn(asAnna, active, bob.id, true)).toBe(false);
    expect(canEditColumn(asAnna, old, anna.id, true)).toBe(false);
  });
  it("target must be a visible participant", () => {
    expect(canEditColumn(asAnna, active, anna.id, false)).toBe(false);
    expect(canEditColumn(asAdmin, active, anna.id, false)).toBe(false);
  });
  it("admin edits everything, including old tastings", () => {
    expect(canEditColumn(asAdmin, active, bob.id, true)).toBe(true);
    expect(canEditColumn(asAdmin, old, bob.id, true)).toBe(true);
  });
  it("impersonating admin has the impersonated user's rights", () => {
    expect(canEditColumn(adminAsAnna, active, anna.id, true)).toBe(true);
    expect(canEditColumn(adminAsAnna, active, bob.id, true)).toBe(false);
    expect(canEditColumn(adminAsAnna, old, anna.id, true)).toBe(false);
  });
});
