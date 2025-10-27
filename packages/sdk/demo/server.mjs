import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sdkRoot = path.resolve(__dirname, "..");
const defaultPort = Number(process.env.SDK_DEMO_PORT ?? 4173);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let pathname = url.pathname;
    if (pathname === "/") {
      pathname = "/demo/index.html";
    }

    const normalized = path.normalize(path.join(sdkRoot, pathname));
    if (!normalized.startsWith(sdkRoot)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    const data = await fs.readFile(normalized);
    res.writeHead(200, { "Content-Type": contentTypeFor(normalized) });
    res.end(data);
  } catch (error) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(defaultPort, () => {
  console.log(`SDK demo available at http://localhost:${defaultPort}`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down demo server...");
  server.close(() => process.exit(0));
});

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
      return "text/javascript";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}
