"use strict";

const http = require("node:http");
const wire = require("../src");

const app = (req, res) => {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain");
  res.end(`hello from ${req.url}`);
};

async function main() {
  const tunnel = wire.new(app);

  const server = http.createServer((req, res) => {
    tunnel.invoke("/ignored", { req, res }).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });
  });

  server.listen(3000, "127.0.0.1", () => {
    console.log("listening on http://127.0.0.1:3000");
    console.log("try: curl http://127.0.0.1:3000/hello");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
