import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { User } from "../shared/types";
import type { AppEnv, Viewer } from "./env";

const SESSION_COOKIE = "__Host-rb_session";
const OAUTH_COOKIE = "__Host-rb_oauth";
const SESSION_DAYS = 30;

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

const sha256 = async (s: string) =>
  b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

const origin = (c: Context) => new URL(c.req.url).origin;

/** Only allow same-site relative return paths. */
const safeReturn = (p: string | undefined) =>
  p && p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/\\") ? p : "/";

export const loadViewer: MiddlewareHandler<AppEnv> = async (c, next) => {
  const anon: Viewer = { email: null, tokenHash: null, realUser: null, user: null, impersonating: false };
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    c.set("viewer", anon);
    return next();
  }
  const tokenHash = await sha256(token);
  const session = await c.env.DB.prepare(
    "SELECT email, impersonate_user_id FROM auth_sessions WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(tokenHash, new Date().toISOString())
    .first<{ email: string; impersonate_user_id: number | null }>();
  if (!session) {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    c.set("viewer", anon);
    return next();
  }

  const realUser = await c.env.DB.prepare("SELECT id, email, nickname, role FROM users WHERE email = ?")
    .bind(session.email)
    .first<User>();
  let user = realUser;
  let impersonating = false;
  if (realUser?.role === "admin" && session.impersonate_user_id) {
    const target = await c.env.DB.prepare("SELECT id, email, nickname, role FROM users WHERE id = ?")
      .bind(session.impersonate_user_id)
      .first<User>();
    if (target) {
      user = target;
      impersonating = true;
    }
  }
  c.set("viewer", { email: session.email, tokenHash, realUser, user, impersonating });
  return next();
};

export const auth = new Hono<AppEnv>();

auth.get("/login", async (c) => {
  const state = randomToken(16);
  const nonce = randomToken(16);
  const verifier = randomToken(32);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const ret = safeReturn(c.req.query("return"));

  setCookie(c, OAUTH_COOKIE, JSON.stringify({ state, nonce, verifier, ret }), {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 600,
  });

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin(c)}/auth/callback`,
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return c.redirect(url.toString());
});

auth.get("/callback", async (c) => {
  const raw = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: "/", secure: true });
  if (!raw) return c.text("Login expired, please try again.", 400);
  const saved = JSON.parse(raw) as { state: string; nonce: string; verifier: string; ret: string };

  const code = c.req.query("code");
  if (!code || c.req.query("state") !== saved.state) return c.text("Invalid login state.", 400);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin(c)}/auth/callback`,
      grant_type: "authorization_code",
      code_verifier: saved.verifier,
    }),
  });
  if (!tokenRes.ok) {
    console.error("google token exchange failed", tokenRes.status, await tokenRes.text());
    return c.text("Login failed.", 502);
  }
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  if (!id_token) return c.text("Login failed.", 502);

  // The ID token came directly from Google's token endpoint over TLS, so per
  // OIDC Core 3.1.3.7 claim validation is sufficient (no signature check needed).
  const payloadPart = id_token.split(".")[1] ?? "";
  const claims = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)),
    ),
  ) as { iss: string; aud: string; exp: number; nonce?: string; email?: string; email_verified?: boolean };

  const validIss = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (
    !validIss ||
    claims.aud !== c.env.GOOGLE_CLIENT_ID ||
    claims.exp * 1000 < Date.now() ||
    claims.nonce !== saved.nonce ||
    !claims.email ||
    claims.email_verified !== true
  ) {
    return c.text("Login failed: invalid token.", 400);
  }

  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").bind(new Date().toISOString()),
    c.env.DB.prepare("INSERT INTO auth_sessions (token_hash, email, expires_at) VALUES (?, ?, ?)").bind(
      await sha256(token),
      claims.email.toLowerCase(),
      expires.toISOString(),
    ),
  ]);
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires,
  });
  return c.redirect(safeReturn(saved.ret));
});

auth.post("/logout", async (c) => {
  const { tokenHash } = c.get("viewer");
  if (tokenHash) await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(tokenHash).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});
