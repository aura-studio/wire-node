"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const wire = require("../src");

test("wire.new passes native req and res objects directly", async () => {
  let seenReq;
  let seenRes;

  const app = (req, res) => {
    seenReq = req;
    seenRes = res;
    res.statusCode = 201;
    res.setHeader("Content-Type", "text/plain");
    res.end(`created ${req.method} ${req.url}`);
  };

  const tunnel = wire.new(app);
  assert.equal(wire.isTunnelNode(tunnel), true);

  const result = await withServer((req, res) => tunnel.invoke("/ignored", { req, res }), {
    method: "POST",
    path: "/echo?x=1",
  });

  assert.equal(seenReq instanceof http.IncomingMessage, true);
  assert.equal(seenRes instanceof http.ServerResponse, true);
  assert.equal(result.statusCode, 201);
  assert.equal(result.body, "created POST /echo?x=1");
});

test("wire.new accepts http.Server targets", async () => {
  const app = (req, res) => {
    res.end(`server ${req.url}`);
  };
  const server = http.createServer(app);
  const tunnel = wire.new(server);

  const result = await withServer((req, res) => tunnel.invoke("/ignored", { req, res }), {
    method: "GET",
    path: "/server",
  });

  assert.equal(result.body, "server /server");
});

test("wire.new does not call framework app lifecycle methods", async () => {
  const app = (req, res) => {
    res.end("ok");
  };
  app.handle = app;
  app.init = () => {
    throw new Error("framework init should not be called");
  };

  const tunnel = wire.new(app);
  await tunnel.init();

  const result = await withServer((req, res) => tunnel.invoke("/ignored", { req, res }), {
    method: "GET",
    path: "/framework",
  });

  assert.equal(result.body, "ok");
});

test("wire.new rejects unsupported targets", () => {
  assert.throws(() => wire.new(null), /requires a Node HTTP handler/);
  assert.throws(() => wire.new({}), /requires a Node HTTP handler/);
  assert.throws(() => wire.new({ emit() {} }), /requires a Node HTTP handler/);
});

test("wire tunnel rejects invalid invoke payloads", async () => {
  const tunnel = wire.new((_req, res) => res.end("ok"));

  await assert.rejects(
    () => tunnel.invoke("/ignored", null),
    /requires \{ req, res \}/
  );
  await assert.rejects(
    () => tunnel.invoke("/ignored", { req: {}, res: {} }),
    /requires req to be an HTTP request object/
  );
});

function withServer(handler, requestOptions) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(String(err && err.message ? err.message : err));
          return;
        }
        res.destroy(err);
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const req = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          method: requestOptions.method || "GET",
          path: requestOptions.path || "/",
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            server.close(() => {
              resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
          });
        }
      );
      req.on("error", (err) => {
        server.close(() => reject(err));
      });
      req.end(requestOptions.body || "");
    });
  });
}
