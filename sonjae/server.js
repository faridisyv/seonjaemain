// Sonjae (손재) server — deliberately dependency-free.
// Two partners just need `node server.js`. No npm install, no version drift.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

// ---- In-memory room store -------------------------------------------------
// { roomId: { createdAt, status, slotsA: [4 x dataURL|null], slotsB: [...],
//             frame, filter, stickers: [{id, emoji|src, x, y, scale, rot}],
//             finalStrip: dataURL|null } }
const rooms = {};

function newRoom() {
  return {
    createdAt: Date.now(),
    status: "waiting", // waiting -> both-joined -> composing -> done
    slotsA: [null, null, null, null],
    slotsB: [null, null, null, null],
    frame: "lavender",
    filter: "none",
    stickers: [],
    finalStrip: null,
  };
}

function send(res, status, body, contentType = "application/json") {
  const payload = contentType === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    const MAX = 15 * 1024 * 1024; // 15MB safety cap for base64 images
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return send(res, 403, "Forbidden", "text/plain");
  }
  fs.readFile(resolved, (err, data) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    const ext = path.extname(resolved);
    send(res, 200, data, MIME[ext] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;

  if (req.method === "OPTIONS") return send(res, 204, "");

  try {
    // POST /api/room/create
    if (pathname === "/api/room/create" && req.method === "POST") {
      const id = crypto.randomBytes(4).toString("hex");
      rooms[id] = newRoom();
      return send(res, 200, { roomId: id, room: rooms[id] });
    }

    // GET /api/room/:id
    let m = pathname.match(/^\/api\/room\/([a-zA-Z0-9]+)$/);
    if (m && req.method === "GET") {
      const room = rooms[m[1]];
      if (!room) return send(res, 404, { error: "Room not found" });
      return send(res, 200, { room });
    }

    // POST /api/room/:id/upload   body: { role: 'A'|'B', slot: 0-3, image: dataURL }
    m = pathname.match(/^\/api\/room\/([a-zA-Z0-9]+)\/upload$/);
    if (m && req.method === "POST") {
      const room = rooms[m[1]];
      if (!room) return send(res, 404, { error: "Room not found" });
      const body = await readJsonBody(req);
      const { role, slot, image } = body;
      if (!["A", "B"].includes(role) || typeof slot !== "number" || slot < 0 || slot > 3 || !image) {
        return send(res, 400, { error: "Invalid upload payload" });
      }
      const key = role === "A" ? "slotsA" : "slotsB";
      room[key][slot] = image;
      const aFull = room.slotsA.every(Boolean);
      const bFull = room.slotsB.every(Boolean);
      if (aFull && bFull) room.status = "composing";
      else room.status = "both-joined";
      return send(res, 200, { room });
    }

    // POST /api/room/:id/save   body: { image: dataURL, frame, filter, stickers }
    m = pathname.match(/^\/api\/room\/([a-zA-Z0-9]+)\/save$/);
    if (m && req.method === "POST") {
      const room = rooms[m[1]];
      if (!room) return send(res, 404, { error: "Room not found" });
      const body = await readJsonBody(req);
      if (!body.image) return send(res, 400, { error: "Missing image" });
      room.finalStrip = body.image;
      if (body.frame) room.frame = body.frame;
      if (body.filter) room.filter = body.filter;
      if (body.stickers) room.stickers = body.stickers;
      room.status = "done";
      return send(res, 200, { ok: true });
    }

    // GET /api/strip/:id   -> raw PNG bytes, for QR-scanned mobile download
    m = pathname.match(/^\/api\/strip\/([a-zA-Z0-9]+)$/);
    if (m && req.method === "GET") {
      const room = rooms[m[1]];
      if (!room || !room.finalStrip) return send(res, 404, { error: "Strip not ready" });
      const base64 = room.finalStrip.replace(/^data:image\/\w+;base64,/, "");
      const buf = Buffer.from(base64, "base64");
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Disposition": `inline; filename="sonjae-${m[1]}.png"`,
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(buf);
    }

    // Fallback: static files
    if (req.method === "GET") return serveStatic(req, res, pathname);

    return send(res, 404, { error: "Not found" });
  } catch (err) {
    return send(res, 500, { error: err.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`\n손재 Sonjae is running: http://localhost:${PORT}\n`);
  console.log("Share your local network address with your partner if you're both");
  console.log("on the same network, or deploy this folder to any Node host for");
  console.log("cross-country use.\n");
});
