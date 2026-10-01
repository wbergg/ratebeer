import { isAdmin } from "../shared/authz";
import type { Beer, Me, Participant, Tasting, User } from "../shared/types";
import { api, esc } from "./api";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $("view");

let tastings: Tasting[] = [];
let users: User[] = [];
let currentTab = "tastings";
let selectedTastingId: number | null = null;

function toast(msg: string, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast${isErr ? " err" : ""}`;
  t.hidden = false;
  window.clearTimeout((t as unknown as { _h?: number })._h);
  (t as unknown as { _h?: number })._h = window.setTimeout(() => (t.hidden = true), 2500);
}

async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) toast(ok);
    return r;
  } catch (e) {
    toast(e instanceof Error ? e.message : "Failed", true);
    return undefined;
  }
}

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Two-step destructive button: first click arms it (label changes), second click within 3 s runs it. */
function confirmClick(btn: HTMLButtonElement, armedLabel: string, action: () => Promise<void>) {
  const label = btn.textContent;
  btn.onclick = async () => {
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = armedLabel;
      window.setTimeout(() => {
        btn.dataset.armed = "";
        btn.textContent = label;
      }, 3000);
      return;
    }
    btn.disabled = true;
    await action();
    btn.disabled = false;
  };
}

// ---------- drag & drop sortable list ----------

function makeSortable(list: HTMLElement, onReorder: (ids: number[]) => void) {
  let dragged: HTMLElement | null = null;
  const ids = () => [...list.querySelectorAll<HTMLElement>("li[data-id]")].map((li) => Number(li.dataset.id));
  const clearMarks = () => list.querySelectorAll("li").forEach((li) => li.classList.remove("drop-before", "drop-after"));

  list.querySelectorAll<HTMLElement>("li[data-id]").forEach((li) => {
    const handle = li.querySelector<HTMLElement>(".handle");
    // Only start dragging from the handle so inputs stay usable.
    handle?.addEventListener("mousedown", () => (li.draggable = true));
    handle?.addEventListener("touchstart", () => (li.draggable = true), { passive: true });
    li.addEventListener("dragstart", (e) => {
      dragged = li;
      li.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", li.dataset.id!);
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      li.draggable = false;
      clearMarks();
      dragged = null;
    });
    li.addEventListener("dragover", (e) => {
      if (!dragged || dragged === li) return;
      e.preventDefault();
      clearMarks();
      const after = e.offsetY > li.offsetHeight / 2;
      li.classList.add(after ? "drop-after" : "drop-before");
    });
    li.addEventListener("drop", (e) => {
      if (!dragged || dragged === li) return;
      e.preventDefault();
      const after = li.classList.contains("drop-after");
      li[after ? "after" : "before"](dragged);
      clearMarks();
      onReorder(ids());
    });
    li.querySelector<HTMLButtonElement>("[data-up]")?.addEventListener("click", () => {
      const prev = li.previousElementSibling;
      if (prev) {
        prev.before(li);
        onReorder(ids());
      }
    });
    li.querySelector<HTMLButtonElement>("[data-down]")?.addEventListener("click", () => {
      const next = li.nextElementSibling;
      if (next) {
        next.after(li);
        onReorder(ids());
      }
    });
  });
}

const moveButtons = `<span class="handle" title="Drag to reorder">⠿</span>
  <button class="btn ghost small" data-up title="Move up">↑</button>
  <button class="btn ghost small" data-down title="Move down">↓</button>`;

function tastingPicker(): string {
  if (tastings.length === 0) return `<p class="muted">Create a tasting first.</p>`;
  if (selectedTastingId === null || !tastings.some((t) => t.id === selectedTastingId)) {
    selectedTastingId = (tastings.find((t) => t.is_active) ?? tastings[0]!).id;
  }
  return `<div class="form-row" style="margin-bottom:16px"><label for="tp">Tasting</label>
    <select id="tp">${tastings
      .map((t) => `<option value="${t.id}" ${t.id === selectedTastingId ? "selected" : ""}>${esc(t.name)}${t.is_active ? " (active)" : ""}</option>`)
      .join("")}</select></div>`;
}
function bindTastingPicker() {
  const tp = document.getElementById("tp") as HTMLSelectElement | null;
  if (tp)
    tp.onchange = () => {
      selectedTastingId = Number(tp.value);
      void render();
    };
}

// ---------- tabs ----------

async function renderTastings() {
  tastings = await api<Tasting[]>("/api/admin/tastings");
  view.innerHTML = `
    <div class="card"><h3>New tasting</h3>
      <form class="form-row" id="new-tasting">
        <input name="name" placeholder="Name, e.g. Christmas 2026" required>
        <input name="slug" placeholder="slug" class="narrow" required pattern="[a-z0-9][a-z0-9\\-]*">
        <button class="btn">Create</button>
      </form></div>
    <div class="card"><h3>Tastings</h3>
      <ul class="list">${
        tastings
          .map(
            (t) => `<li data-id="${t.id}">
              <input class="grow" value="${esc(t.name)}" data-name>
              <span class="muted">/${esc(t.slug)}</span>
              <span class="pill ${t.is_active ? "on" : ""}">${t.is_active ? "active" : "closed"}</span>
              <button class="btn ghost small" data-save>Save name</button>
              <button class="btn small ${t.is_active ? "ghost" : ""}" data-activate>${t.is_active ? "Close" : "Make active"}</button>
              <a class="btn ghost small" href="${t.is_active ? "/" : `/?s=${encodeURIComponent(t.slug)}`}">Open</a>
              <button class="btn danger small" data-delete>Delete</button>
            </li>`,
          )
          .join("") || `<li class="muted">No tastings yet.</li>`
      }</ul></div>`;

  const form = $<HTMLFormElement>("new-tasting");
  const nameIn = form.elements.namedItem("name") as HTMLInputElement;
  const slugIn = form.elements.namedItem("slug") as HTMLInputElement;
  nameIn.oninput = () => {
    if (!slugIn.dataset.touched) slugIn.value = slugify(nameIn.value);
  };
  slugIn.oninput = () => (slugIn.dataset.touched = "1");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const created = await run(() => api<Tasting>("/api/admin/tastings", { method: "POST", body: { name: nameIn.value, slug: slugIn.value } }), "Tasting created");
    if (created) {
      selectedTastingId = created.id;
      void render();
    }
  };

  view.querySelectorAll<HTMLElement>("li[data-id]").forEach((li) => {
    const id = Number(li.dataset.id);
    const t = tastings.find((x) => x.id === id)!;
    li.querySelector<HTMLButtonElement>("[data-save]")!.onclick = () =>
      run(() => api(`/api/admin/tastings/${id}`, { method: "PATCH", body: { name: li.querySelector<HTMLInputElement>("[data-name]")!.value } }), "Saved");
    li.querySelector<HTMLButtonElement>("[data-activate]")!.onclick = async () => {
      await run(() => api(`/api/admin/tastings/${id}/activate`, { method: "POST", body: { active: !t.is_active } }), t.is_active ? "Tasting closed" : "Tasting is now active");
      void render();
    };
    confirmClick(li.querySelector<HTMLButtonElement>("[data-delete]")!, "Delete tasting + all beers, ratings & log?", async () => {
      const ok = await run(() => api(`/api/admin/tastings/${id}`, { method: "DELETE" }), "Tasting deleted");
      if (ok) {
        if (selectedTastingId === id) selectedTastingId = null;
        void render();
      }
    });
  });
}

async function renderBeers() {
  tastings = await api<Tasting[]>("/api/admin/tastings");
  const picker = tastingPicker();
  if (selectedTastingId === null) {
    view.innerHTML = picker;
    return;
  }
  const tid = selectedTastingId;
  const beers = await api<Beer[]>(`/api/admin/tastings/${tid}/beers`);
  const visible = beers.filter((b) => !b.hidden_at);
  const hidden = beers.filter((b) => b.hidden_at);
  const beerRow = (b: Beer) => `<li data-id="${b.id}" class="${b.hidden_at ? "hidden-item" : ""}">
      ${b.hidden_at ? "" : moveButtons}
      <input class="grow" data-f="name" value="${esc(b.name)}" placeholder="Name">
      <input class="narrow" data-f="size_ml" type="number" min="1" value="${b.size_ml ?? ""}" placeholder="ml" style="width:80px">
      <input class="narrow" data-f="abv" type="number" step="0.1" min="0" max="100" value="${b.abv ?? ""}" placeholder="ABV %" style="width:80px">
      <input class="grow" data-f="image_url" type="url" value="${esc(b.image_url ?? "")}" placeholder="Image URL (https://…)">
      <button class="btn ghost small" data-save>Save</button>
      <button class="btn ${b.hidden_at ? "ghost" : "danger"} small" data-hide>${b.hidden_at ? "Restore" : "Remove"}</button>
      ${b.hidden_at ? `<button class="btn danger small" data-purge>Delete permanently</button>` : ""}
    </li>`;

  view.innerHTML = `${picker}
    <div class="card"><h3>Add beer</h3>
      <form class="form-row" id="new-beer">
        <input name="name" placeholder="Name" required>
        <input name="size_ml" type="number" min="1" placeholder="Size (ml)" class="narrow">
        <input name="abv" type="number" step="0.1" min="0" max="100" placeholder="ABV %" class="narrow">
        <input name="image_url" type="url" placeholder="Image URL (optional)">
        <button class="btn">Add</button>
      </form></div>
    <div class="card"><h3>Beers <span class="muted">(drag or use arrows to set matrix order)</span></h3>
      <ul class="list" id="beer-list">${visible.map(beerRow).join("") || `<li class="muted">No beers yet.</li>`}</ul>
      ${hidden.length ? `<h3 style="margin-top:16px">Removed</h3><ul class="list">${hidden.map(beerRow).join("")}</ul>` : ""}
    </div>`;
  bindTastingPicker();

  const form = $<HTMLFormElement>("new-beer");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const ok = await run(() => api(`/api/admin/tastings/${tid}/beers`, { method: "POST", body: Object.fromEntries(fd) }), "Beer added");
    if (ok) {
      await render();
      (document.querySelector("#new-beer input[name=name]") as HTMLInputElement | null)?.focus();
    }
  };

  view.querySelectorAll<HTMLElement>("li[data-id]").forEach((li) => {
    const id = Number(li.dataset.id);
    const b = beers.find((x) => x.id === id)!;
    li.querySelector<HTMLButtonElement>("[data-save]")!.onclick = () => {
      const body: Record<string, string> = {};
      li.querySelectorAll<HTMLInputElement>("input[data-f]").forEach((i) => (body[i.dataset.f!] = i.value));
      return run(() => api(`/api/admin/tastings/${tid}/beers/${id}`, { method: "PATCH", body }), "Saved");
    };
    li.querySelector<HTMLButtonElement>("[data-hide]")!.onclick = async () => {
      await run(() => api(`/api/admin/tastings/${tid}/beers/${id}`, { method: "PATCH", body: { hidden: !b.hidden_at } }));
      void render();
    };
    const purge = li.querySelector<HTMLButtonElement>("[data-purge]");
    if (purge)
      confirmClick(purge, "Delete beer + all its ratings?", async () => {
        const ok = await run(() => api(`/api/admin/tastings/${tid}/beers/${id}`, { method: "DELETE" }), "Beer deleted");
        if (ok) void render();
      });
  });
  makeSortable($("beer-list"), (ids) => void run(() => api(`/api/admin/tastings/${tid}/beers/order`, { method: "PUT", body: { ids } }), "Order saved"));
}

async function renderRoster() {
  [tastings, users] = await Promise.all([api<Tasting[]>("/api/admin/tastings"), api<User[]>("/api/admin/users")]);
  const picker = tastingPicker();
  if (selectedTastingId === null) {
    view.innerHTML = picker;
    return;
  }
  const tid = selectedTastingId;
  const parts = await api<Participant[]>(`/api/admin/tastings/${tid}/participants`);
  const visible = parts.filter((p) => !p.hidden_at);
  const hidden = parts.filter((p) => p.hidden_at);
  const inRoster = new Set(visible.map((p) => p.user_id));
  const available = users.filter((u) => !inRoster.has(u.id));
  const row = (p: Participant) => `<li data-id="${p.user_id}" class="${p.hidden_at ? "hidden-item" : ""}">
      ${p.hidden_at ? "" : moveButtons}
      <span class="grow"><b>${esc(p.nickname)}</b></span>
      <button class="btn ${p.hidden_at ? "ghost" : "danger"} small" data-hide>${p.hidden_at ? "Restore" : "Remove"}</button>
      ${p.hidden_at ? `<button class="btn danger small" data-purge>Delete permanently</button>` : ""}
    </li>`;

  view.innerHTML = `${picker}
    <div class="card"><h3>Add participant</h3>
      ${
        available.length
          ? `<form class="form-row" id="add-part"><select name="userId">${available
              .map((u) => `<option value="${u.id}">${esc(u.nickname)} (${esc(u.email)})</option>`)
              .join("")}</select><button class="btn">Add</button></form>`
          : `<p class="muted">All users are participants. Add more users in the Users tab.</p>`
      }</div>
    <div class="card"><h3>Participants <span class="muted">(column order)</span></h3>
      <ul class="list" id="part-list">${visible.map(row).join("") || `<li class="muted">No participants yet.</li>`}</ul>
      ${hidden.length ? `<h3 style="margin-top:16px">Removed</h3><ul class="list">${hidden.map(row).join("")}</ul>` : ""}
    </div>`;
  bindTastingPicker();

  const form = document.getElementById("add-part") as HTMLFormElement | null;
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      const userId = Number((form.elements.namedItem("userId") as HTMLSelectElement).value);
      await run(() => api(`/api/admin/tastings/${tid}/participants`, { method: "POST", body: { userId } }), "Participant added");
      void render();
    };

  view.querySelectorAll<HTMLElement>("li[data-id]").forEach((li) => {
    const uid = Number(li.dataset.id);
    const p = parts.find((x) => x.user_id === uid)!;
    li.querySelector<HTMLButtonElement>("[data-hide]")!.onclick = async () => {
      await run(() => api(`/api/admin/tastings/${tid}/participants/${uid}`, { method: "PATCH", body: { hidden: !p.hidden_at } }));
      void render();
    };
    const purge = li.querySelector<HTMLButtonElement>("[data-purge]");
    if (purge)
      confirmClick(purge, "Delete + all their ratings here?", async () => {
        const ok = await run(() => api(`/api/admin/tastings/${tid}/participants/${uid}`, { method: "DELETE" }), "Participant deleted");
        if (ok) void render();
      });
  });
  makeSortable($("part-list"), (ids) => void run(() => api(`/api/admin/tastings/${tid}/participants/order`, { method: "PUT", body: { ids } }), "Order saved"));
}

async function renderUsers(me: Me) {
  users = await api<User[]>("/api/admin/users");
  const roleSel = (r: string) =>
    `<select data-f="role"><option value="user" ${r === "user" ? "selected" : ""}>user</option><option value="admin" ${r === "admin" ? "selected" : ""}>admin</option></select>`;
  view.innerHTML = `
    <div class="card"><h3>Add user</h3>
      <form class="form-row" id="new-user">
        <input name="nickname" placeholder="Nickname" required maxlength="40">
        <input name="email" type="email" placeholder="Google email" required>
        ${roleSel("user").replace("data-f", "name")}
        <button class="btn">Add</button>
      </form></div>
    <div class="card"><h3>Users</h3>
      <ul class="list">${users
        .map(
          (u) => `<li data-id="${u.id}">
            <input data-f="nickname" value="${esc(u.nickname)}" style="width:140px">
            <input class="grow" data-f="email" type="email" value="${esc(u.email)}">
            ${roleSel(u.role)}
            <button class="btn ghost small" data-save>Save</button>
            ${u.id !== me.realUser!.id ? `<button class="btn ghost small" data-imp>View as</button><button class="btn danger small" data-del>Delete</button>` : `<span class="muted">(you)</span>`}
          </li>`,
        )
        .join("")}</ul></div>`;

  const form = $<HTMLFormElement>("new-user");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const ok = await run(() => api("/api/admin/users", { method: "POST", body: Object.fromEntries(new FormData(form)) }), "User added");
    if (ok) void render();
  };
  view.querySelectorAll<HTMLElement>("li[data-id]").forEach((li) => {
    const id = Number(li.dataset.id);
    const val = (f: string) => li.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-f=${f}]`)!.value;
    li.querySelector<HTMLButtonElement>("[data-save]")!.onclick = () =>
      run(() => api(`/api/admin/users/${id}`, { method: "PATCH", body: { nickname: val("nickname"), email: val("email"), role: val("role") } }), "Saved");
    const imp = li.querySelector<HTMLButtonElement>("[data-imp]");
    if (imp)
      imp.onclick = async () => {
        const ok = await run(() => api("/api/admin/impersonate", { method: "POST", body: { userId: id } }));
        if (ok) location.href = "/";
      };
    const del = li.querySelector<HTMLButtonElement>("[data-del]");
    if (del)
      del.onclick = async () => {
        if (del.dataset.armed !== "1") {
          del.dataset.armed = "1";
          del.textContent = "Confirm delete";
          window.setTimeout(() => {
            del.dataset.armed = "";
            del.textContent = "Delete";
          }, 3000);
          return;
        }
        const ok = await run(() => api(`/api/admin/users/${id}`, { method: "DELETE" }), "User deleted");
        if (ok) void render();
      };
  });
}

let me: Me;
async function render() {
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === currentTab));
  try {
    if (currentTab === "tastings") await renderTastings();
    else if (currentTab === "beers") await renderBeers();
    else if (currentTab === "roster") await renderRoster();
    else await renderUsers(me);
  } catch (e) {
    view.innerHTML = `<p class="muted">${esc(e instanceof Error ? e.message : "Failed to load")}</p>`;
  }
}

async function boot() {
  me = await api<Me>("/api/me");
  if (!isAdmin(me)) {
    view.innerHTML = me.impersonating
      ? `<p>You are viewing as another user. <a href="/">Go back</a> and press Stop first.</p>`
      : `<p>Admins only. <a href="/auth/login?return=/admin">Log in</a></p>`;
    $("tabs").hidden = true;
    return;
  }
  currentTab = location.hash.slice(1) || "tastings";
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach(
    (b) =>
      (b.onclick = () => {
        currentTab = b.dataset.tab!;
        history.replaceState(null, "", `#${currentTab}`);
        void render();
      }),
  );
  await render();
}

void boot();
