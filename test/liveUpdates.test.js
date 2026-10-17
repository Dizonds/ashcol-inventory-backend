import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { streamUpdates, watchMutations } from "../src/liveUpdates.js";

test("live updates publish successful committed mutations and skip failures and ticket creation", () => {
  const messages = [];
  const stream = new EventEmitter();
  stream.set = () => {};
  stream.flushHeaders = () => {};
  stream.write = (message) => { messages.push(message); return true; };
  streamUpdates({}, stream);
  try {
    assert.match(messages[0], /event: ready/);
    const response = new EventEmitter();
    response.statusCode = 200;
    watchMutations({ method: "PATCH", originalUrl: "/api/service-vans/VAN-1/driver" }, response, () => {});
    assert.equal(messages.length, 1);
    response.emit("finish");
    assert.equal(messages.length, 2);
    assert.match(messages[1], /event: change/);
    assert.deepEqual(Object.keys(JSON.parse(messages[1].split("data: ")[1])), ["revision"]);
    for (const [method, originalUrl, statusCode] of [
      ["PATCH", "/api/service-vans/VAN-1/driver", 403],
      ["POST", "/api/movement-tickets", 201],
      ["POST", "/api/service-vans/VAN-1/usage-ticket", 201],
      ["GET", "/api/brands", 200],
      ["POST", "/api/auth/login", 200],
    ]) {
      const ignored = new EventEmitter();
      ignored.statusCode = statusCode;
      watchMutations({ method, originalUrl }, ignored, () => {});
      ignored.emit("finish");
    }
    assert.equal(messages.length, 2);
  } finally {
    stream.emit("close");
  }
});
