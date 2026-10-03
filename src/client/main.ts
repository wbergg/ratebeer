import { canEditColumn, isAdmin, isRegistered } from "../shared/authz";
import { average, consumedBoard, leaderboard } from "../shared/logic";
import { EVENT_PAGE, type Beer, type Me, type Participant, type Rating, type RatingEvent, type ServerMessage, type Snapshot, type Tasting } from "../shared/types";
import { api, ApiError, esc, formatBeerMeta, formatTime } from "./api";
import { connectLive } from "./ws";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const key = (beerId: number, userId: number) => `${beerId}:${userId}`;

const state = {
  me: null as Me | null,
  tastings: [] as Tasting[],
  tasting: null as Tasting | null,
  beers: [] as Beer[],
  participants: [] as Participant[],
  ratings: new Map<string, Rating>(),
  events: [] as RatingEvent[],
  moreEvents: false,
  ready: false,
  buffer: [] as ServerMessage[],
};

// ---------- header ----------

function renderHeader() {
  const me = state.me!;
  const area = $("auth-area");
  const loginHref = `/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`;
  if (!me.email) {
    area.innerHTML = `<a class="btn" href="${loginHref}">Log in with Google</a>`;
  } else {
    const name = me.realUser ? `<b>${esc(me.realUser.nickname)}</b>` : esc(me.email);
    area.innerHTML = `
      <span class="who">${name}</span>
      ${isAdmin(me) ? `<a class="btn ghost" href="/admin">Admin</a>` : ""}
      <button class="btn ghost" id="logout">Log out</button>`;
    $("logout").onclick = async () => {
      await api("/auth/logout", { method: "POST", body: {} });
      location.reload();
    };
  }

  const banner = $("banner");
  if (me.impersonating && me.user) {
    banner.hidden = false;
    banner.innerHTML = `Viewing as <b>${esc(me.user.nickname)}</b>. Your edits are logged as them.
      <button class="btn small" id="stop-imp">Stop</button>`;
    $("stop-imp").onclick = async () => {
      await api("/api/admin/impersonate", { method: "POST", body: { userId: null } });
      location.reload();
    };
  } else if (me.email && !me.user) {
    banner.hidden = false;
    banner.innerHTML = `Signed in as <b>${esc(me.email)}</b>, but you're not a registered participant. Ask an admin to add you.`;
  } else {
    banner.hidden = true;
  }

  const sel = $<HTMLSelectElement>("tasting-select");
  if (isRegistered(me) && state.tastings.length > 1) {
    sel.hidden = false;
    sel.innerHTML = state.tastings
      .map(
        (t) =>
          `<option value="${esc(t.slug)}" ${t.slug === state.tasting?.slug ? "selected" : ""}>${esc(t.name)}${
            t.is_active ? " (active)" : ""
          }</option>`,
      )
      .join("");
    sel.onchange = () => {
      const t = state.tastings.find((x) => x.slug === sel.value);
      location.href = t?.is_active ? "/" : `/?s=${encodeURIComponent(sel.value)}`;
    };
  } else {
    sel.hidden = true;
  }
}

// ---------- matrix ----------

const canEdit = (userId: number) => !!state.tasting && canEditColumn(state.me!, state.tasting, userId, true);

function scoresFor(beerId: number): number[] {
  const out: number[] = [];
  for (const p of state.participants) {
    const r = state.ratings.get(key(beerId, p.user_id));
    if (r) out.push(r.score);
  }
  return out;
}

const narrow = window.matchMedia("(max-width: 640px)");
narrow.addEventListener("change", () => state.ready && renderMatrix());

/** Column order: as set by the admin, except on phones your own column comes first. */
function columns(): Participant[] {
  const meId = state.me?.user?.id;
  if (!narrow.matches || meId === undefined) return state.participants;
  const mine = state.participants.filter((p) => p.user_id === meId);
  return mine.length ? [...mine, ...state.participants.filter((p) => p.user_id !== meId)] : state.participants;
}

function renderMatrix(flashKey?: string) {
  const table = $("matrix");
  const meId = state.me?.user?.id;
  const cols = columns();
  if (state.beers.length === 0) {
    $("matrix-wrap").hidden = true;
    showEmpty(state.participants.length ? "No beers yet." : "No beers or participants yet.");
    return;
  }
  $("matrix-wrap").hidden = false;
  $("empty").hidden = true;

  const head = `<thead><tr><th class="beer">Beer</th>${cols
    .map((p) => `<th class="${p.user_id === meId ? "me" : ""}" title="${esc(p.nickname)}">${esc(p.nickname)}</th>`)
    .join("")}<th class="avg">Avg</th></tr></thead>`;

  // Reserve the image column for every row if any beer has an image, so names line up.
  const anyImage = state.beers.some((b) => b.image_url);
  const rows = state.beers
    .map((b) => {
      const meta = formatBeerMeta(b);
      const img = b.image_url
        ? `<img src="${esc(b.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : anyImage
          ? `<span class="img-slot"></span>`
          : "";
      const cells = cols
        .map((p) => {
          const r = state.ratings.get(key(b.id, p.user_id));
          const cls = ["cell", r ? "" : "none", canEdit(p.user_id) ? "editable" : "", key(b.id, p.user_id) === flashKey ? "flash" : ""]
            .filter(Boolean)
            .join(" ");
          const note = r?.comment ? `<span class="note"></span>` : "";
          return `<td class="${cls}" data-beer="${b.id}" data-user="${p.user_id}">${r ? r.score : "–"}${note}</td>`;
        })
        .join("");
      const scores = scoresFor(b.id);
      const avg = average(scores);
      const avgCell = avg === null ? "–" : `${avg.toFixed(1)}<small>${scores.length} vote${scores.length === 1 ? "" : "s"}</small>`;
      return `<tr><th class="beer" scope="row"><div class="beer-cell">${img}<div class="beer-text"><div class="beer-name" title="${esc(
        b.name,
      )}">${esc(b.name)}</div>${meta ? `<div class="beer-meta">${esc(meta)}</div>` : ""}</div></div></th>${cells}<td class="avg">${avgCell}</td></tr>`;
    })
    .join("");

  table.innerHTML = head + `<tbody>${rows}</tbody>`;
}

function showEmpty(msg: string) {
  const el = $("empty");
  el.hidden = false;
  el.textContent = msg;
}

// Tooltip for comments, enlarged beer image on hover, click to edit (delegated).
let tip: HTMLDivElement | null = null;
function hideTip() {
  tip?.remove();
  tip = null;
}
function showImagePreview(img: HTMLImageElement) {
  tip = document.createElement("div");
  tip.className = "img-preview";
  const big = document.createElement("img");
  big.src = img.src;
  big.alt = "";
  big.referrerPolicy = "no-referrer";
  tip.append(big);
  document.body.append(tip);
  const rect = img.getBoundingClientRect();
  const h = tip.offsetHeight;
  // Right of the thumbnail, vertically centred on it, kept inside the viewport.
  tip.style.left = `${rect.right + 12}px`;
  tip.style.top = `${Math.max(8, Math.min(rect.top + rect.height / 2 - h / 2, window.innerHeight - h - 8))}px`;
}
$("matrix").addEventListener("pointerover", (e) => {
  const target = e.target as HTMLElement;
  hideTip();
  // Mouse only: on touch, a tap would just flash the preview.
  if (e.pointerType === "mouse" && target instanceof HTMLImageElement && target.closest(".beer-cell")) {
    showImagePreview(target);
    return;
  }
  const td = target.closest<HTMLTableCellElement>("td.cell");
  if (!td) return;
  const r = state.ratings.get(key(Number(td.dataset.beer), Number(td.dataset.user)));
  if (!r?.comment) return;
  tip = document.createElement("div");
  tip.className = "tip";
  tip.textContent = r.comment;
  document.body.append(tip);
  const rect = td.getBoundingClientRect();
  tip.style.left = `${Math.min(rect.left, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${rect.bottom + 6}px`;
});
$("matrix").addEventListener("mouseleave", hideTip);
$("matrix-wrap").addEventListener("scroll", hideTip, { passive: true });
$("matrix").addEventListener("click", (e) => {
  const td = (e.target as HTMLElement).closest<HTMLTableCellElement>("td.cell");
  if (!td) return;
  const beerId = Number(td.dataset.beer);
  const userId = Number(td.dataset.user);
  hideTip();
  if (canEdit(userId)) openPopup(td, beerId, userId);
  else {
    // Touch devices have no hover: show the comment on tap instead.
    const r = state.ratings.get(key(beerId, userId));
    if (r?.comment) td.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  }
});

// ---------- popup ----------

function openPopup(anchor: HTMLElement, beerId: number, userId: number) {
  const beer = state.beers.find((b) => b.id === beerId)!;
  const who = state.participants.find((p) => p.user_id === userId)!;
  const existing = state.ratings.get(key(beerId, userId));
  let selected: number | null = existing?.score ?? null;
  const own = userId === state.me?.user?.id;

  const popup = $("popup");
  const backdrop = $("popup-backdrop");
  popup.innerHTML = `
    <h3>${esc(beer.name)}</h3>
    <div class="sub">${own ? "Your rating" : `Rating for ${esc(who.nickname)}`}</div>
    <div class="stars" role="radiogroup" aria-label="Rating">${Array.from({ length: 10 }, (_, i) => i + 1)
      .map((n) => `<button type="button" role="radio" data-n="${n}" aria-label="${n} of 10">★</button>`)
      .join("")}</div>
    <div class="star-value" id="pp-value"></div>
    <textarea id="pp-comment" maxlength="500" placeholder="Comment (optional)"></textarea>
    <div class="error" id="pp-error" hidden></div>
    <div class="actions">
      ${existing ? `<button type="button" class="btn danger left" id="pp-clear">Remove rating</button>` : ""}
      <button type="button" class="btn ghost" id="pp-cancel">Cancel</button>
      <button type="button" class="btn" id="pp-save">Save</button>
    </div>`;

  const comment = $<HTMLTextAreaElement>("pp-comment");
  comment.value = existing?.comment ?? "";
  const stars = [...popup.querySelectorAll<HTMLButtonElement>(".stars button")];
  const valueEl = $("pp-value");
  const saveBtn = $<HTMLButtonElement>("pp-save");

  // Fill stars up to `n` (hover preview) or up to the selected value.
  const paint = (n: number | null) => {
    stars.forEach((b) => {
      const v = Number(b.dataset.n);
      b.classList.toggle("on", n !== null && v <= n);
      b.setAttribute("aria-checked", String(v === selected));
    });
    valueEl.textContent = n === null ? "Tap a star to rate" : `${n} / 10`;
  };
  const pick = (n: number) => {
    selected = n;
    saveBtn.disabled = false;
    paint(n);
  };
  stars.forEach((b) => {
    const n = Number(b.dataset.n);
    b.onclick = () => pick(n);
    b.onmouseenter = () => paint(n);
  });
  popup.querySelector(".stars")!.addEventListener("mouseleave", () => paint(selected));
  saveBtn.disabled = selected === null;
  paint(selected);

  popup.hidden = false;
  backdrop.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const top = Math.min(rect.bottom + 6, window.innerHeight - popup.offsetHeight - 8);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - popup.offsetWidth - 8);
  popup.style.top = `${Math.max(8, top)}px`;
  popup.style.left = `${left}px`;

  const close = () => {
    popup.hidden = true;
    backdrop.hidden = true;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "Enter" && !e.shiftKey && selected) {
      e.preventDefault();
      void submit(selected);
    } else if (/^[0-9]$/.test(e.key) && document.activeElement !== comment) {
      pick(e.key === "0" ? 10 : Number(e.key));
    }
  };
  document.addEventListener("keydown", onKey);
  backdrop.onclick = close;
  $("pp-cancel").onclick = close;

  const submit = async (score: number | null) => {
    const errEl = $("pp-error");
    errEl.hidden = true;
    try {
      await api(`/api/tastings/${encodeURIComponent(state.tasting!.slug)}/ratings`, {
        method: "POST",
        body: { beerId, userId, score, comment: comment.value },
      });
      close();
    } catch (e) {
      errEl.hidden = false;
      errEl.textContent = e instanceof Error ? e.message : "Failed to save";
    }
  };
  saveBtn.onclick = () => selected && submit(selected);
  if (existing) $("pp-clear").onclick = () => submit(null);
}

// ---------- log & leaderboard ----------

function eventHtml(e: RatingEvent): string {
  const nick = `<b>${esc(e.nickname)}</b>`;
  const beer = `<b>${esc(e.beer_name)}</b>`;
  const quoted = e.comment ? `<span class="comment">“${esc(e.comment)}”</span>` : "";
  const withComment = quoted ? ` with comment ${quoted}` : "";
  switch (e.type) {
    case "rated":
      return `${nick} gave ${beer} ${e.new_score} out of 10${withComment}`;
    case "changed":
      return `${nick} changed rating of ${beer} <span class="from-to">from ${e.old_score} to ${e.new_score}</span>${withComment}`;
    case "cleared":
      return `${nick} removed rating of ${beer} (was ${e.old_score})`;
    case "commented":
      return `${nick} updated comment on ${beer}: ${quoted}`;
  }
}

function renderLog(newId?: number) {
  const log = $("log");
  const admin = isAdmin(state.me!);
  log.innerHTML = state.events.length
    ? state.events
        .map(
          (e) =>
            `<li class="${e.id === newId ? "new" : ""}"><time datetime="${esc(e.created_at)}" title="${esc(
              new Date(e.created_at).toLocaleString(),
            )}">${esc(formatTime(e.created_at))}</time><span class="text">${eventHtml(e)}</span>${
              admin
                ? `<span class="log-actions">
                    <button class="del" data-del="${e.id}" data-mode="force" title="Force remove: clear this rating and all its log lines">Force</button>
                    <button class="del" data-del="${e.id}" data-mode="line" title="Delete this log line only" aria-label="Delete log line">×</button>
                  </span>`
                : ""
            }</li>`,
        )
        .join("")
    : `<li class="log-empty">No ratings yet.</li>`;
  $("log-more").hidden = !state.moreEvents;
}

function renderBoard() {
  const scores = new Map(state.beers.map((b) => [b.id, scoresFor(b.id)]));
  const rows = leaderboard(state.beers, scores);
  $("board").innerHTML = rows.length
    ? rows
        .map(
          (r) => `<li><span class="rank ${r.rank <= 3 ? `r${r.rank}` : ""}">${r.rank}</span>
            <span class="name" title="${esc(r.name)}">${esc(r.name)}</span>
            <span class="score">${r.avg.toFixed(1)}</span>
            <span class="votes">${r.votes} vote${r.votes === 1 ? "" : "s"}</span></li>`,
        )
        .join("")
    : `<li class="board-empty">Nothing rated yet.</li>`;
}

function renderConsumed() {
  const rows = consumedBoard(state.participants, new Set(state.beers.map((b) => b.id)), state.ratings.values());
  $("consumed").innerHTML = rows.length
    ? rows
        .map(
          (r) => `<li><span class="rank ${r.rank <= 3 ? `r${r.rank}` : ""}">${r.rank}</span>
            <span class="name" title="${esc(r.nickname)}">${esc(r.nickname)}</span>
            <span class="score">${r.count}</span>
            <span class="votes" title="Reached ${r.count} at ${esc(new Date(r.reachedAt).toLocaleString())}">${r.count === 1 ? "beer" : "beers"}</span></li>`,
        )
        .join("")
    : `<li class="board-empty">Nobody has had a beer yet.</li>`;
}

function renderAll() {
  $("tasting-title").textContent = state.tasting?.name ?? "";
  document.title = state.tasting ? `${state.tasting.name} · ratebeer` : "ratebeer";
  renderHeader();
  renderMatrix();
  renderLog();
  renderBoard();
  renderConsumed();
  $("lower").hidden = false;
}

// Admin: "×" deletes the log line; "Force" also clears the rating and all its log lines.
// Both need a second click to confirm.
$("log").addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-del]");
  if (!btn) return;
  const force = btn.dataset.mode === "force";
  if (btn.dataset.armed !== "1") {
    const label = btn.textContent;
    btn.dataset.armed = "1";
    btn.textContent = force ? "Clear rating + log?" : "Delete line?";
    window.setTimeout(() => {
      if (!btn.isConnected) return;
      btn.dataset.armed = "";
      btn.textContent = label;
    }, 3000);
    return;
  }
  btn.disabled = true;
  try {
    const id = btn.dataset.del;
    if (force) await api(`/api/admin/events/${id}/force`, { method: "POST" });
    else await api(`/api/admin/events/${id}`, { method: "DELETE" });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Failed";
    console.error(err);
  }
});

const logMore = $<HTMLButtonElement>("log-more");
logMore.onclick = async () => {
  const last = state.events[state.events.length - 1];
  if (!last || logMore.disabled) return;
  logMore.disabled = true;
  try {
    const older = await api<RatingEvent[]>(
      `/api/tastings/${encodeURIComponent(state.tasting!.slug)}/events?before=${last.id}`,
    );
    // A snapshot reload may have replaced the list meanwhile; never show a line twice.
    const seen = new Set(state.events.map((e) => e.id));
    state.events.push(...older.filter((e) => !seen.has(e.id)));
    state.moreEvents = older.length === EVENT_PAGE;
    renderLog();
  } finally {
    logMore.disabled = false;
  }
};

// ---------- live updates ----------

function applyMessage(m: ServerMessage) {
  switch (m.type) {
    case "rating": {
      if (state.events.some((e) => e.id === m.event.id)) return; // already in snapshot
      const k = key(m.beerId, m.userId);
      if (m.rating) state.ratings.set(k, m.rating);
      else state.ratings.delete(k);
      state.events.unshift(m.event);
      renderMatrix(k);
      renderLog(m.event.id);
      renderBoard();
      renderConsumed();
  renderConsumed();
      break;
    }
    case "beers":
      state.beers = m.beers;
      renderMatrix();
      renderBoard();
      renderConsumed();
  renderConsumed();
      break;
    case "participants":
      state.participants = m.participants;
      renderMatrix();
      renderBoard();
      renderConsumed();
  renderConsumed();
      break;
    case "purged": {
      const gone = new Set(m.eventIds);
      state.events = state.events.filter((e) => !gone.has(e.id));
      for (const [k, r] of state.ratings) {
        if ((m.beerId === null || r.beer_id === m.beerId) && (m.userId === null || r.user_id === m.userId)) {
          state.ratings.delete(k);
        }
      }
      renderMatrix(m.beerId !== null && m.userId !== null ? key(m.beerId, m.userId) : undefined);
      renderLog();
      renderBoard();
      renderConsumed();
  renderConsumed();
      break;
    }
    case "tastingDeleted":
      location.href = "/";
      break;
    case "eventRemoved":
      state.events = state.events.filter((e) => e.id !== m.id);
      renderLog();
      break;
    case "tasting": {
      const activeChanged = state.tasting?.is_active !== m.tasting.is_active;
      state.tasting = m.tasting;
      // Keep the header's tasting picker in sync: at most one tasting is active.
      state.tastings = state.tastings.map((t) =>
        t.id === m.tasting.id ? m.tasting : m.tasting.is_active ? { ...t, is_active: 0 } : t,
      );
      if (activeChanged) void loadSnapshot().catch(() => location.reload());
      else renderAll();
      break;
    }
  }
}

async function loadSnapshot() {
  const snap = await api<Snapshot>(`/api/tastings/${encodeURIComponent(state.tasting!.slug)}/snapshot`);
  state.tasting = snap.tasting;
  state.beers = snap.beers;
  state.participants = snap.participants;
  state.ratings = new Map(snap.ratings.map((r) => [key(r.beer_id, r.user_id), r]));
  state.events = snap.events;
  state.moreEvents = snap.events.length === EVENT_PAGE;
  state.ready = true;
  renderAll();
  const buffered = state.buffer.splice(0);
  buffered.forEach(applyMessage);
}

// ---------- boot ----------

async function boot() {
  [state.me, state.tastings] = await Promise.all([api<Me>("/api/me"), api<Tasting[]>("/api/tastings")]);
  const wanted = new URLSearchParams(location.search).get("s");
  const tasting = wanted ? state.tastings.find((t) => t.slug === wanted) : state.tastings.find((t) => t.is_active);
  state.tasting = tasting ?? null;
  renderHeader();

  if (!tasting) {
    showEmpty(wanted ? "That tasting doesn't exist or isn't public." : "No tasting is active right now.");
    return;
  }

  connectLive(tasting.slug, {
    onMessage: (m) => (state.ready ? applyMessage(m) : state.buffer.push(m)),
    onOpen: (reconnected) => {
      if (reconnected) {
        state.ready = false;
        void loadSnapshot();
      }
    },
    onStatus: (up) => $("live").classList.toggle("on", up),
  });
  await loadSnapshot();
}

boot().catch((e) => {
  console.error(e);
  showEmpty(e instanceof ApiError && e.status === 404 ? "Not found." : "Something went wrong loading ratebeer.");
});
