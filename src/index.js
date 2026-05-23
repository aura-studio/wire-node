"use strict";

const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { STATUS_CODES } = require("node:http");

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

  async invoke(_route, wireRequest) {
    const parsed = parseWireRequest(wireRequest);
    const req = new WireRequest(parsed);
    const res = new WireResponse(req);

    await invokeHTTPHandler(this.handler, req, res, this.options.timeoutMs);
    if (Buffer.isBuffer(wireRequest) || wireRequest instanceof Uint8Array) {
      return res.toWireBuffer();
    }
    return res.toWire();
  }
}

class WireRequest extends Readable {
  constructor(parsed) {
    super();
    this.method = parsed.method;
    this.url = parsed.url;
    this.originalUrl = parsed.url;
    this.headers = parsed.headers;
    this.rawHeaders = parsed.rawHeaders;
    this.httpVersion = parsed.httpVersion;
    this.httpVersionMajor = Number(parsed.httpVersion.split(".")[0]) || 1;
    this.httpVersionMinor = Number(parsed.httpVersion.split(".")[1]) || 1;
    this.socket = new EventEmitter();
    this.socket.remoteAddress = "";
    this.connection = this.socket;
    this._body = parsed.body;
    this._sent = false;
  }

  _read() {
    if (this._sent) return;
    this._sent = true;
    if (this._body.length > 0) this.push(this._body);
    this.push(null);
  }

  get(name) {
    return this.headers[String(name).toLowerCase()];
  }

  header(name) {
    return this.get(name);
  }
}

class WireResponse extends EventEmitter {
  constructor(req) {
    super();
    this.req = req;
    this.statusCode = 200;
    this.statusMessage = "";
    this.headersSent = false;
    this.writableEnded = false;
    this.finished = false;
    this.socket = req.socket;
    this.locals = {};
    this._headers = new Map();
    this._headerNames = new Map();
    this._chunks = [];

    // Express replaces the response prototype. Keep the wire capture methods
    // as own properties so they survive that prototype swap.
    for (const name of [
      "setHeader",
      "getHeader",
      "getHeaders",
      "hasHeader",
      "removeHeader",
      "writeHead",
      "flushHeaders",
      "write",
      "end",
      "toWire",
      "toWireBuffer",
    ]) {
      this[name] = this[name].bind(this);
    }
  }

  setHeader(name, value) {
    const key = normalizeHeaderName(name);
    this._headers.set(key, value);
    this._headerNames.set(key, String(name));
    return this;
  }

  getHeader(name) {
    return this._headers.get(normalizeHeaderName(name));
  }

  getHeaders() {
    const headers = {};
    for (const [key, value] of this._headers.entries()) {
      headers[key] = value;
    }
    return headers;
  }

  hasHeader(name) {
    return this._headers.has(normalizeHeaderName(name));
  }

  removeHeader(name) {
    const key = normalizeHeaderName(name);
    this._headers.delete(key);
    this._headerNames.delete(key);
  }

  writeHead(statusCode, statusMessage, headers) {
    this.statusCode = statusCode;
    if (typeof statusMessage === "string") {
      this.statusMessage = statusMessage;
    } else {
      headers = statusMessage;
    }
    if (headers && typeof headers === "object") {
      for (const [name, value] of Object.entries(headers)) {
        this.setHeader(name, value);
      }
    }
    this.headersSent = true;
    return this;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  write(chunk, encoding, callback) {
    if (this.writableEnded) {
      throw new Error("write after end");
    }
    this.headersSent = true;
    if (chunk != null) {
      this._chunks.push(toBuffer(chunk, encoding));
    }
    if (typeof callback === "function") callback();
    return true;
  }

  end(chunk, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (chunk != null) this.write(chunk, encoding);
    this.headersSent = true;
    this.writableEnded = true;
    this.finished = true;
    if (typeof callback === "function") callback();
    this.emit("finish");
    this.emit("close");
    return this;
  }

  toWire() {
    return this.toWireBuffer().toString("utf8");
  }

  toWireBuffer() {
    const body = Buffer.concat(this._chunks);
    if (!this.hasHeader("Content-Length") && !this.hasHeader("Transfer-Encoding")) {
      this.setHeader("Content-Length", String(body.length));
    }

    const reason = this.statusMessage || STATUS_CODES[this.statusCode] || "OK";
    const lines = [`HTTP/1.1 ${this.statusCode} ${reason}`];

    for (const [key, value] of this._headers.entries()) {
      const name = this._headerNames.get(key) || key;
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else {
        lines.push(`${name}: ${value}`);
      }
    }

    const head = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
    return Buffer.concat([head, body]);
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

function parseWireRequest(raw) {
  const bytes = toWireInputBuffer(raw);
  const split = splitHTTPWire(bytes);
  const head = split.head.toString("latin1");
  const lines = head.split(/\r?\n/).filter((line) => line.length > 0);
  const requestLine = lines.shift() || "";
  const match = requestLine.match(/^(\S+)\s+(\S+)\s+HTTP\/(\d+(?:\.\d+)?)$/i);
  if (!match) {
    throw new Error("invalid HTTP wire request");
  }

  const headers = {};
  const rawHeaders = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    headers[name.toLowerCase()] = value;
    rawHeaders.push(name, value);
  }

  return {
    method: match[1].toUpperCase(),
    url: match[2],
    httpVersion: match[3],
    headers,
    rawHeaders,
    body: split.body,
  };
}

function toWireInputBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  return Buffer.from(String(raw || ""), "utf8");
}

function splitHTTPWire(bytes) {
  const crlf = Buffer.from("\r\n\r\n", "latin1");
  const lf = Buffer.from("\n\n", "latin1");
  let idx = bytes.indexOf(crlf);
  let sepLen = crlf.length;
  if (idx < 0) {
    idx = bytes.indexOf(lf);
    sepLen = lf.length;
  }
  if (idx < 0) {
    return { head: bytes, body: Buffer.alloc(0) };
  }
  return {
    head: bytes.subarray(0, idx),
    body: bytes.subarray(idx + sepLen),
  };
}

async function invokeHTTPHandler(handler, req, res, timeoutMs) {
  let handlerResult;
  let handlerError;

  const next = (err) => {
    if (err) handlerError = err;
  };

  handlerResult = handler(req, res, next);
  if (handlerResult && typeof handlerResult.then === "function") {
    await handlerResult;
  }
  if (handlerError) throw handlerError;
  if (!res.writableEnded) {
    await waitForFinish(res, timeoutMs);
  }
}

function waitForFinish(res, timeoutMs) {
  if (res.writableEnded) return Promise.resolve();
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

function normalizeHeaderName(name) {
  return String(name).toLowerCase();
}

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(String(chunk), encoding || "utf8");
}

module.exports = {
  new: createWire,
  create: createWire,
  Wire: WireTunnel,
  WireTunnel,
  WireRequest,
  WireResponse,
  parseWireRequest,
  isTunnelNode,
};
