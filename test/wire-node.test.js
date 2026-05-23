"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const wire = require("../src");

test("wire.new wraps a Node HTTP handler as TunnelNode", async () => {
  const app = (req, res) => {
    res.statusCode = 201;
    res.setHeader("Content-Type", "text/plain");

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.end(`created ${req.method} ${req.url}: ${Buffer.concat(chunks).toString("utf8")}`);
    });
  };

  const tunnel = wire.new(app);
  assert.equal(wire.isTunnelNode(tunnel), true);

  const rsp = await tunnel.invoke(
    "/ignored",
    "POST /echo?x=1 HTTP/1.1\r\nHost: example.com\r\nContent-Length: 5\r\n\r\nhello"
  );

  assert.match(rsp, /^HTTP\/1\.1 201 Created\r\n/);
  assert.match(rsp, /Content-Type: text\/plain\r\n/);
  assert.match(rsp, /\r\n\r\ncreated POST \/echo\?x=1: hello$/);
});

test("wire.new accepts http.Server targets", async () => {
  const app = (req, res) => {
    res.end(`server ${req.url}`);
  };
  const server = http.createServer(app);
  const tunnel = wire.new(server);

  const rsp = await tunnel.invoke(
    "/ignored",
    "GET /server HTTP/1.1\r\nHost: example.com\r\n\r\n"
  );

  assert.match(rsp, /\r\n\r\nserver \/server$/);
});

test("wire.new rejects unsupported targets", () => {
  assert.throws(() => wire.new(null), /requires a Node HTTP handler/);
  assert.throws(() => wire.new({}), /requires a Node HTTP handler/);
  assert.throws(() => wire.new({ emit() {} }), /requires a Node HTTP handler/);
});
