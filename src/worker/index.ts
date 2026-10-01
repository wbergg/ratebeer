import { Hono } from "hono";
import { auth, loadViewer } from "./auth";
import type { AppEnv } from "./env";
import { admin } from "./routes/admin";
import { api, ws } from "./routes/public";

export { SessionRoom } from "./room";

const app = new Hono<AppEnv>();

// CSRF: state-changing requests must come from our own origin as JSON.
app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = new URL(c.req.url).origin;
    if (c.req.header("Origin") !== origin) return c.json({ error: "Bad origin" }, 403);
    if (c.req.path.startsWith("/api/") && !c.req.header("Content-Type")?.startsWith("application/json")) {
      return c.json({ error: "Expected JSON" }, 415);
    }
  }
  return next();
});

app.use("*", loadViewer);

app.route("/auth", auth);
app.route("/api/admin", admin);
app.route("/api", api);
app.route("/ws", ws);

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : c.env.ASSETS.fetch(c.req.raw)));
app.onError((err, c) => {
  if (err instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

export default app;
