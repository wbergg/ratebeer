# ratebeer

Live beer-tasting matrix on Cloudflare Workers + D1 + Durable Objects, served at **https://ratebeer.wberg.com**.

## Features
- **Matrix:** beers are rows and participants are columns. The last column is each beer's average (people who haven't rated are excluded).
- **Public viewing:** anyone with the link can view the **active** tasting, read-only.
- **Rating:** after "Log in with Google", registered users click a cell in their own column to rate the beer 1–10, optionally add a comment, or clear the rating.
- **Live updates:** every change appears instantly for all viewers over WebSockets. This covers the matrix, the event log and the leaderboard.
- **Event log**, for example:
  - "wberg gave Punk IPA 7 out of 10 with comment "hoppy""
  - "wberg changed rating of Punk IPA from 7 to 8"
  - "wberg updated comment on Punk IPA: "…""
  - "wberg removed rating of Punk IPA (was 8)"
- **Leaderboard:** beers sorted by average, then number of votes. The top 3 get gold, silver and bronze, and exact ties share a medal.
- **Consumed board:** participants ranked by how many beers they have rated. On a tie, whoever got there first wins. People with 0 beers aren't shown.
- **Several tastings** (sessions). One is active and public. Older ones are visible to registered users and are read-only except for admins.
- **Admin panel** (`/admin`):
  - **Tastings:** create, rename, activate or close.
  - **Beers:** name, size in ml, ABV, image URL; reorder by drag-and-drop or ↑/↓; remove and restore.
  - **Participants:** per-tasting roster and column order.
  - **Users:** nickname, Google email, role `user`/`admin`, and **View as** (impersonation).
- **Roles:**
  - **anonymous / unregistered Google account:** read-only.
  - **user:** can edit their own column in the active tasting.
  - **admin:** can edit everything.

## Project layout

| Path | What |
|---|---|
| `src/worker/index.ts` | Hono app, CSRF check, routing; exports the `SessionRoom` DO |
| `src/worker/auth.ts` | Google OIDC login/logout, cookie sessions, viewer resolution |
| `src/worker/routes/public.ts` | `/api/me`, tastings, snapshot, event paging, rating POST, WebSocket upgrade |
| `src/worker/routes/admin.ts` | `/api/admin/*`: tastings, users, roster, beers, ordering, impersonation |
| `src/worker/room.ts` | `SessionRoom` Durable Object: serialised rating writes + broadcast |
| `src/worker/db.ts` | D1 query helpers |
| `src/shared/` | Types, rating/leaderboard logic, permission rules (used by Worker **and** browser) |
| `src/client/main.ts` | Matrix page: rendering, rating popup, log, leaderboard, live updates |
| `src/client/admin.ts` | Admin panel |
| `src/client/ws.ts` | Reconnecting WebSocket client |
| `migrations/` | D1 schema |
| `seed/admin.sql` | Bootstraps the first admin |
| `test/` | Unit tests (vitest) |

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars          # fill in Google OAuth client id/secret
npx wrangler d1 migrations apply ratebeer --local
npx wrangler d1 execute ratebeer --local --file seed/admin.sql
npm run dev                             # http://localhost:5173
npm test
npm run typecheck
```

## Deploying

```sh
npm run deploy     # = vite build && wrangler deploy
```

> Always use `npm run deploy`. The Vite plugin generates the real deploy config (`dist/ratebeer/wrangler.json`) at build time, so a bare `wrangler deploy` uses a stale build.

Schema changes: add `migrations/000N_name.sql`, then run `npx wrangler d1 migrations apply ratebeer --remote` **before** `npm run deploy`. New code may depend on new columns.

### First-time setup (already done for production)
1. Create the database with `npx wrangler d1 create ratebeer`, then put the `database_id` into `wrangler.jsonc`. Keep only the `DB` binding.
2. Create a Google OAuth client in Google Cloud Console → Google Auth Platform → Clients → *Web application*.
   - Authorized redirect URIs: `https://ratebeer.wberg.com/auth/callback` and `http://localhost:5173/auth/callback`.
   - Publish the app (Audience → *Publish app*) so any Google account can sign in. The `openid`/`email` scopes need no verification.
3. Run `npx wrangler secret put GOOGLE_CLIENT_ID` and `npx wrangler secret put GOOGLE_CLIENT_SECRET`.
4. Run `npx wrangler d1 migrations apply ratebeer --remote`, then `npx wrangler d1 execute ratebeer --remote --file seed/admin.sql`.
5. Run `npm run deploy`.

### Troubleshooting
- **`redirect_uri_mismatch`:** the OAuth client whose ID matches `GOOGLE_CLIENT_ID` must list exactly `https://ratebeer.wberg.com/auth/callback` under *Authorized redirect URIs*. Changes can take a few minutes to apply.
- **Admin button missing:** the admin row's email in `users` must match your Google login email exactly. To fix it:
  `npx wrangler d1 execute ratebeer --remote --command "UPDATE users SET email='you@example.com' WHERE nickname='wberg'"`
