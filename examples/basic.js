"use strict";

const http = require("node:http");
const wire = require("../src");

const app = (req, res) => {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain");
  res.end(`hello from ${req.url}`);
};

async function runTunnelExample() {
  const tunnel = wire.new(app);
  const response = await tunnel.invoke(
    "/ignored",
    "GET /hello HTTP/1.1\r\nHost: example.com\r\n\r\n"
  );

  console.log(response);
}

function serveHTTP() {
  const server = http.createServer(app);
  server.listen(3000, "127.0.0.1", () => {
    console.log("listening on http://127.0.0.1:3000");
  });
}

const main = process.argv.includes("--serve") ? serveHTTP : runTunnelExample;

Promise.resolve(main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
