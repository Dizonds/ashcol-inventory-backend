const clients = new Set();
let revision = 0;

function send(response, event) {
  response.write(`event: ${event}\ndata: ${JSON.stringify({ revision })}\n\n`);
}

export function streamUpdates(req, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  clients.add(res);
  send(res, "ready");
  const heartbeat = setInterval(() => {
    if (req.loginSession && new Date(req.loginSession.expiresAt).getTime() <= Date.now()) {
      res.end();
      return;
    }
    res.write(": heartbeat\n\n");
  }, 20000);
  heartbeat.unref();
  res.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

export function broadcastUpdate() {
  revision += 1;
  for (const response of clients) {
    if (response.destroyed || response.writableEnded) clients.delete(response);
    else send(response, "change");
  }
}

export function watchMutations(req, res, next) {
  const path = req.originalUrl.split("?")[0];
  const changesData = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && (
    /^\/api\/(products|transfers|brands|suppliers|users|requests|service-vans|job-orders)(\/|$)/.test(path) ||
    path === "/api/auth/me"
  ) && !path.endsWith("/usage-ticket");
  if (changesData) {
    res.once("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) broadcastUpdate();
    });
  }
  next();
}
