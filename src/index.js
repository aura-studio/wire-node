"use strict";

const {
  TunnelNode,
  metaToString,
  isTunnelNode,
} = loadTunnelNode();

class WireTunnel extends TunnelNode {
  constructor(app, options = {}) {
    super();
    assertWireTarget(app);
    this.app = app;
    this.handler = normalizeHTTPHandler(app);
    this.options = {
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

function loadTunnelNode() {
  try {
    return require("@aura-studio/tunnel-node");
  } catch (_) {
    return require("../../tunnel-node/src");
  }
}

function normalizeHTTPHandler(app) {
  if (typeof app === "function") return app;
  if (app && typeof app.callback === "function") return app.callback();
  if (app && typeof app.handle === "function") {
    return (req, res, next) => app.handle(req, res, next);
  }
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
  return (
    req &&
    typeof req.method === "string" &&
    typeof req.url === "string" &&
    typeof req.headers === "object" &&
    typeof req.on === "function"
  );
}

function isHTTPServerResponse(res) {
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

  if (options.waitForFinish && !res.writableEnded && !res.finished) {
    await waitForResponseFinish(res, options.timeoutMs);
  }

  return result;
}

function waitForResponseFinish(res, timeoutMs) {
  if (res.writableEnded || res.finished) return Promise.resolve();

  return new Promise((resolve, reject) => {
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

module.exports = {
  new: createWire,
  create: createWire,
  Wire: WireTunnel,
  WireTunnel,
  isTunnelNode,
};
