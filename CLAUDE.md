# ratebeer: notes for Claude

A live beer-tasting rating matrix, built as a Cloudflare Worker with D1 and Durable Objects. Production: https://ratebeer.wberg.com (custom domain only; `workers_dev` and `preview_urls` are disabled, so there is never a `*.workers.dev` URL).

## Stack
- **Worker:** Hono (`src/worker/`). **Frontend:** vanilla TS SPA built by Vite (`index.html`, `admin.html`, `src/client/`), served through Workers Static Assets.
- `@cloudflare/vite-plugin` builds both. **`wrangler deploy` deploys the generated `dist/ratebeer/wrangler.json`, not `wrangler.jsonc`.** Always run `npm run deploy` (build + deploy). A bare `wrangler deploy` ships a stale config or stale code.
- D1 binding `DB` (database `ratebeer`). DO binding `ROOM` → `SessionRoom` (SQLite-backed, migration tag `v1`).
- Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (`wrangler secret put`). Local values go in `.dev.vars` (gitignored, template in `.dev.vars.example`).

## Commands
```sh
npm run dev        # vite + local D1/DO at http://localhost:5173
npm test           # vitest: pure logic + authz (test/), no workers pool
npm run typecheck  # tsc -b (split configs: tsconfig.worker.json / tsconfig.client.json)
npm run deploy     # vite build && wrangler deploy
npx wrangler d1 migrations apply ratebeer --local|--remote
```

## Domain model (agreed with the user; don't change without asking)
- **Tastings** are sessions; the DB uses "tastings" so they don't clash with `auth_sessions`. Several can exist and at most one is active (enforced by a partial unique index).
  - The active tasting is public and read-only for anonymous visitors.
  - Non-active tastings are visible only to registered users and are read-only except for admins.
- **Users** are global (`users.role` is `user` or `admin`; "none" means the email isn't in the table). Admins choose the **per-tasting roster** (`tasting_participants`). Only admins add users.
- **Beers** belong to one tasting and have: name, `size_ml` (int, shown as "330 ml"), `abv` (real), optional `image_url` (https only), `position`.
- **Layout:** beers are rows and people are columns. On phones (≤640px) the viewer's own column is moved first (`columns()` in `main.ts`), with a compact header and matrix. Desktop keeps the admin-set order. The last column is **Avg**: the mean over people who rated the beer (NONE excluded), shown to 1 decimal.
- **Ratings:** 1–10 or none, with an optional comment.
  - The popup uses **10 stars** and pre-fills the existing score and comment. The matrix cells still show numbers.
  - A blank comment keeps the existing one. An unchanged pre-filled comment is not repeated on the event.
  - "Remove rating" deletes the rating row and logs a `cleared` event. Admins can change or remove any cell.
- **Events** (`events` table): `rated`, `changed` (old→new), `cleared`, `commented` (same score, new comment).
  - `beer_name` and `nickname` are stored as snapshots so the log survives renames.
  - Log wording (in `src/client/main.ts` `eventHtml`):
    - "X gave B 7 out of 10 with comment "…""
    - "X changed rating of B from 7 to 8 with comment "…""
    - "X removed rating of B (was 8)"
    - "X updated comment on B: "…""
  - The log shows the newest 50 plus "Load more", in local time.
  - Admins can delete log lines (× on a line, click twice to confirm) via `DELETE /api/admin/events/:id`, which runs through the DO queue (`deleteEvent`) and broadcasts `eventRemoved`. This removes only the log line, not the rating.
  - **Force** on a log line (`POST /api/admin/events/:id/force`) runs through the DO queue (`purge`). It deletes that user+beer rating and **all** its log lines, as if the beer was never rated, and broadcasts `purged`.
- **Leaderboard:** beers with ≥1 vote, sorted by avg desc, then votes desc, then name. Identical (avg, votes) share a rank and medal. Ranks 1/2/3 are gold/silver/bronze.
- **Consumed board** (below the leaderboard): participants ranked by the number of visible beers they have rated ("consumed").
  - Ties go to whoever reached that count first: the max of their `ratings.created_at`. `created_at` is set on first rating and never changed by edits; a clear + re-rate resets it.
  - Participants with 0 are hidden. Logic is in `consumedBoard()` in `src/shared/logic.ts`.
- **Soft delete:** beers and roster entries get `hidden_at` and can be restored.
  - Once removed, they can be **deleted permanently** via `DELETE /api/admin/tastings/:id/beers/:beerId` or `/participants/:userId`.
  - Permanent deletion is allowed only when `hidden_at` is set (otherwise 409). It also deletes their ratings and events in that tasting.
  - The `hidden_at IS NOT NULL` guard is inside every statement of the `purge()` batch, so a concurrent restore makes the whole delete a no-op (409) rather than wiping ratings of a restored row.
- **Tastings** can be force-deleted, even the active one, via `DELETE /api/admin/tastings/:id`.
  - DO `deleteTasting` deletes events, ratings, beers, roster and the tasting itself. Users are kept.
  - It then broadcasts `tastingDeleted` (clients navigate to `/`) and closes the sockets.
- A user can only be hard-deleted if they have no ratings or events.
- **Impersonation ("View as")** lives in the admin panel → Users tab.
  - It is stored in `auth_sessions.impersonate_user_id`.
  - While impersonating, the admin has exactly the target user's rights, and the admin API is blocked except `/api/admin/impersonate`.
  - Edits are logged as the column owner. The real person is in `events.actor_user_id`, which is **never** sent to clients (`EVENT_COLS` excludes it).

## Architecture notes
- **Permissions** live in `src/shared/authz.ts`, shared by the Worker and the browser (the client computes editable cells itself). `isAdmin` means a real admin who is *not* impersonating.
- **Rating writes:** Worker checks authz → DO `applyRating()` (RPC) → D1 batch (upsert/delete rating + insert event `RETURNING`) → broadcast.
  - The DO keeps an explicit promise queue, because D1 awaits are not covered by DO input gates. Without the queue, concurrent writes would break the old→new chain.
- **Realtime:** one DO per tasting (`idFromName(String(tastingId))`) using hibernatable WebSockets. `"ping"`→`"pong"` is auto-answered.
  - Message types: `rating`, `beers`, `participants`, `tasting`, `eventRemoved`, `purged`, `tastingDeleted`. All hard deletes of ratings/events go through the DO queue (`purge()`, `deleteEvent()`) so they serialise with rating writes.
  - Admin mutations write D1, then call DO `pushBeers()` / `pushParticipants()` / `pushTasting()`. These re-read and broadcast the full list inside the queue, so broadcasts can't arrive out of order.
  - The client refetches the snapshot on reconnect, and when a tasting's active flag changes.
- **Auth:** the Worker runs its own Google OIDC code flow with PKCE, state and nonce (`src/worker/auth.ts`).
  - `id_token` claims are validated without a signature check, because the token comes straight from Google's token endpoint.
  - The cookie is `__Host-rb_session`; D1 stores only its sha256. `redirect_uri` is `<request origin>/auth/callback`.
  - Google Cloud OAuth client redirect URIs: `https://ratebeer.wberg.com/auth/callback` and `http://localhost:5173/auth/callback`.
  - Unregistered Google accounts can log in but stay read-only, with a banner.
- **CSRF:** non-GET requests need `Origin` equal to the request origin; `/api/*` additionally needs a JSON content type.
- **Pure logic** (unit-tested): `src/shared/logic.ts` (`decideRating`, `average`, `leaderboard`).

## Conventions
- Keep shared types in `src/shared/types.ts`. Schema changes go in a new `migrations/000N_*.sql` (never edit applied migrations).
- Client HTML is built with template strings: always `esc()` user data.
- Client calls go through `api()` in `src/client/api.ts`, which always sends JSON on non-GET requests (CSRF check returns 415 otherwise, even for DELETE).
- Testing UI: headless Chromium via Playwright installed in the session scratchpad works. Firefox `--screenshot` captures the page before the JS has rendered, so it isn't useful.
- Never read `package.json`, lock files, `node_modules/`, or `.env`/`.dev.vars`.
