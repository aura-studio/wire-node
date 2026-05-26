"use strict";

class TunnelNode {
  async init() {}

  async invoke() {
    throw new Error("TunnelNode.invoke must be implemented");
  }

  async meta() {
    return "";
  }

  async close() {}

  Init() {
    return this.init();
  }

  Invoke(route, request) {
    return this.invoke(route, request);
  }

  Meta() {
    return Promise.resolve(this.meta()).then(metaToString);
  }

  Close() {
    return this.close();
  }
}

class WireTunnel extends TunnelNode {
  constructor(app, options = {}) {
    super();
    assertWireTarget(app);
    this.app = app;
    this.handler = normalizeHTTPHandler(app);
    this.options = {
      // Native req/res pass-through is the core wire model. Waiting for finish
      // is kept so await tunnel.invoke(...) means the response lifecycle ended.
      waitForFinish: true,
      timeoutMs: 30000,
      ...options,
    };
  }

  async init() {
    await callOptional(this.app, ["init", "Init"]);
  }

  async close() {
    await callOptional(this.app, ["close", "Close"]);
  }

  async meta() {
    const meta = await callOptional(this.app, ["meta", "Meta"]);
    return metaToString(meta);
  }

  async invoke(_route, exchange) {
    // The route is ignored for wire mode because the HTTP request already
    // carries method, url, headers, and body through Node's IncomingMessage.
    return this.handle(exchange);
  }

  async handle(exchange) {
    const { req, res, next } = normalizeExchange(exchange);
    const result = await callHTTPHandler(
      this.handler,
      req,
      res,
      next,
      this.options
    );
    return result === undefined ? res : result;
  }
}

function createWire(app, options) {
  return new WireTunnel(app, options);
}

function normalizeHTTPHandler(app) {
  // The smallest wire target is a plain Node HTTP handler: (req, res) => void.
  if (typeof app === "function") return app;

  // These branches are compatibility adapters. They are not part of the
  // req/res transport itself; they let common app objects expose one handler.
  if (app && typeof app.callback === "function") return app.callback();
  if (app && typeof app.handle === "function") {
    return (req, res, next) => app.handle(req, res, next);
  }

  // A Node http.Server can be reused by emitting the same "request" event
  // that http.createServer emits internally.
  if (isHTTPServer(app)) {
    return (req, res) => app.emit("request", req, res);
  }
  throw new TypeError(
    "wire.new(app) requires a Node HTTP handler, Express-style app, Koa-style app, or http.Server"
  );
}

function assertWireTarget(app) {
  const valid =
    typeof app === "function" ||
    (app && typeof app.callback === "function") ||
    (app && typeof app.handle === "function") ||
    isHTTPServer(app);

  if (!valid) {
    throw new TypeError(
      "wire.new(app) requires a Node HTTP handler, Express-style app, Koa-style app, or http.Server"
    );
  }
}

function isHTTPServer(app) {
  return (
    app &&
    typeof app.emit === "function" &&
    typeof app.on === "function" &&
    typeof app.listen === "function"
  );
}

function normalizeExchange(exchange) {
  // Wire mode intentionally does not serialize HTTP. It requires the caller to
  // pass the live Node request/response pair from the same process.
  if (!exchange || typeof exchange !== "object") {
    throw new TypeError("wire tunnel invoke requires { req, res }");
  }

  const req = exchange.req || exchange.request;
  const res = exchange.res || exchange.response;
  const next = typeof exchange.next === "function" ? exchange.next : undefined;

  if (!isHTTPIncomingMessage(req)) {
    throw new TypeError("wire tunnel invoke requires req to be an HTTP request object");
  }
  if (!isHTTPServerResponse(res)) {
    throw new TypeError("wire tunnel invoke requires res to be an HTTP response object");
  }

  return { req, res, next };
}

function isHTTPIncomingMessage(req) {
  // Use capability checks instead of instanceof so wrapped IncomingMessage
  // objects and compatible framework requests can still pass.
  return (
    req &&
    typeof req.method === "string" &&
    typeof req.url === "string" &&
    typeof req.headers === "object" &&
    typeof req.on === "function"
  );
}

function isHTTPServerResponse(res) {
  // ServerResponse-compatible objects need to be writable and observable. That
  // is enough for Node handlers to set headers, end, and emit lifecycle events.
  return (
    res &&
    typeof res.setHeader === "function" &&
    typeof res.end === "function" &&
    typeof res.on === "function"
  );
}

async function callHTTPHandler(handler, req, res, next, options) {
  let nextError;
  const nextFn = (err) => {
    // Express-style handlers report failures through next(err). Preserve that
    // behavior while still surfacing the error from tunnel.invoke(...).
    if (typeof next === "function") {
      next(err);
    }
    if (err) {
      nextError = err;
    }
  };

  const result = handler(req, res, nextFn);
  if (result && typeof result.then === "function") {
    await result;
  }
  if (nextError) throw nextError;

  // Some handlers finish synchronously, some finish after async stream work.
  // This wait is optional because direct fire-and-forget forwarding can disable
  // it with { waitForFinish: false }.
  if (options.waitForFinish && !res.writableEnded && !res.finished) {
    await waitForResponseFinish(res, options.timeoutMs);
  }

  return result;
}

function waitForResponseFinish(res, timeoutMs) {
  if (res.writableEnded || res.finished) return Promise.resolve();

  return new Promise((resolve, reject) => {
    // A timeout prevents a hung handler from leaving tunnel.invoke unresolved
    // forever when it neither ends the response nor reports an error.
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("HTTP handler did not finish the response"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      res.off("finish", onFinish);
      res.off("close", onFinish);
      res.off("error", onError);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };

    res.once("finish", onFinish);
    res.once("close", onFinish);
    res.once("error", onError);
  });
}

async function callOptional(target, names) {
  for (const name of names) {
    const value = target && target[name];
    if (typeof value === "function") return value.call(target);
    if (typeof value === "string") return value;
    if (value != null && name.toLowerCase() === "meta") return value;
  }
  return "";
}

function metaToString(meta) {
  if (meta == null) return "";
  if (typeof meta === "string") return meta;
  if (Buffer.isBuffer(meta)) return meta.toString("utf8");
  return JSON.stringify(meta, null, 2);
}

function isTunnelNode(value) {
  const lower = ["init", "invoke", "close"].every(
    (name) => typeof value?.[name] === "function"
  );
  const upper = ["Init", "Invoke", "Close"].every(
    (name) => typeof value?.[name] === "function"
  );
  return lower || upper;
}

module.exports = {
  new: createWire,
  create: createWire,
  Wire: WireTunnel,
  WireTunnel,
  TunnelNode,
  metaToString,
  isTunnelNode,
};
