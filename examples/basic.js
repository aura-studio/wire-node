"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const wire = require("../src");

const cases = [
  {
    name: "plain Node handler",
    path: "/plain",
    expected: "plain GET /plain",
    app: (req, res) => {
      send(res, `plain ${req.method} ${req.url}`);
    },
  },
  {
    name: "Express-style app.handle",
    path: "/express",
    expected: "express GET /express",
    app: {
      handle(req, res, next) {
        try {
          send(res, `express ${req.method} ${req.url}`);
        } catch (err) {
          next(err);
        }
      },
    },
  },
  {
    name: "Koa-style app.callback",
    path: "/koa",
    expected: "koa GET /koa",
    app: {
      callback() {
        return async (req, res) => {
          send(res, `koa ${req.method} ${req.url}`);
        };
      },
    },
  },
  {
    name: "http.Server",
    path: "/server",
    expected: "server GET /server",
    app: http.createServer((req, res) => {
      send(res, `server ${req.method} ${req.url}`);
    }),
  },
];

async function main() {
  for (const item of cases) {
    const result = await requestThroughWire(item.app, item.path);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, item.expected);
    console.log(`[ok] ${item.name}: ${result.body}`);
  }
}

function requestThroughWire(app, path) {
  const tunnel = wire.new(app);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      tunnel.invoke("/ignored", { req, res }).catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(err && err.message ? err.message : String(err));
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
          method: "GET",
          path,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            server.close(() => {
              resolve({
                statusCode: res.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
          });
        }
      );

      req.on("error", (err) => {
        server.close(() => reject(err));
      });
      req.end();
    });
  });
}

function send(res, body) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain");
  res.end(body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
