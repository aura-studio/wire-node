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

test("wire.new preserves binary request and response bodies with Buffer wire", async () => {
  const requestBody = Buffer.from([0x00, 0xff, 0x41, 0x42]);
  const responseBody = Buffer.from([0xff, 0x00, 0x43]);

  const app = (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      assert.deepEqual(Buffer.concat(chunks), requestBody);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(responseBody);
    });
  };

  const tunnel = wire.new(app);
  const head = Buffer.from(
    "POST /bin HTTP/1.1\r\nHost: example.com\r\nContent-Length: 4\r\n\r\n",
    "latin1"
  );
  const rsp = await tunnel.invoke("/ignored", Buffer.concat([head, requestBody]));

  assert.equal(Buffer.isBuffer(rsp), true);
  const separator = Buffer.from("\r\n\r\n", "latin1");
  const body = rsp.subarray(rsp.indexOf(separator) + separator.length);
  assert.deepEqual(body, responseBody);
});
