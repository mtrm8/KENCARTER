import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = 8080;

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain"
};

const server = http.createServer((req, res) => {
  let reqUrl = req.url.split("?")[0];
  let filePath = path.join(__dirname, reqUrl === "/" ? "index.html" : reqUrl);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === "ENOENT") {
        fs.readFile(path.join(__dirname, "index.html"), (err2, content2) => {
          if (err2) {
            res.writeHead(404);
            res.end("404 Not Found");
          } else {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(content2, "utf-8");
          }
        });
      } else {
        res.writeHead(500);
        res.end("500 Internal Server Error");
      }
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content, "utf-8");
    }
  });
});

server.listen(PORT, () => {
  console.log(`KEN CARTER store preview server running at http://localhost:${PORT}`);
});
