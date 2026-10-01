import type { ServerMessage } from "../shared/types";

/** Reconnecting WebSocket. `onOpen(reconnected)` fires on every (re)connect. */
export function connectLive(
  slug: string,
  handlers: { onMessage: (m: ServerMessage) => void; onOpen: (reconnected: boolean) => void; onStatus: (up: boolean) => void },
): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let everOpened = false;
  let closed = false;
  let ping: number | undefined;
  let retry: number | undefined;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/tastings/${encodeURIComponent(slug)}`);
    ws.onopen = () => {
      attempt = 0;
      handlers.onStatus(true);
      handlers.onOpen(everOpened);
      everOpened = true;
      ping = window.setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 25_000);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      try {
        handlers.onMessage(JSON.parse(e.data as string) as ServerMessage);
      } catch (err) {
        console.error("bad message", err);
      }
    };
    ws.onclose = () => {
      window.clearInterval(ping);
      handlers.onStatus(false);
      if (closed) return;
      const delay = Math.min(30_000, 500 * 2 ** attempt++) + Math.random() * 500;
      retry = window.setTimeout(open, delay);
    };
  };

  // Reconnect quickly when the tab comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ws?.readyState === WebSocket.CLOSED && !closed) {
      window.clearTimeout(retry);
      attempt = 0;
      open();
    }
  });

  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
