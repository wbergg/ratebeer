export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const method = init?.method ?? "GET";
  // Every non-GET must be JSON to pass the server's CSRF check, even without a payload (e.g. DELETE).
  const body = init?.body ?? (method === "GET" ? undefined : {});
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data;
}

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export const formatBeerMeta = (b: { size_ml: number | null; abv: number | null }) =>
  [b.size_ml ? `${b.size_ml} ml` : "", b.abv !== null && b.abv !== undefined ? `${b.abv} %` : ""]
    .filter(Boolean)
    .join(" · ");

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}
