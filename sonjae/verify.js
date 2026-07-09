// Lightweight smoke test — no test framework dependency.
// Starts the real server on a scratch port and exercises every route.

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
let failures = 0;

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      `${BASE}${urlPath}`,
      { method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
      (res) => {
        let chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString("utf8")); } catch (_) {}
          resolve({ status: res.statusCode, json, raw: buf });
        });
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function check(label, cond) {
  if (cond) {
    console.log(`  ok  - ${label}`);
  } else {
    console.log(`FAIL  - ${label}`);
    failures++;
  }
}

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function main() {
  console.log("Starting server for verification...");
  const server = spawn("node", [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "pipe",
  });
  await new Promise((r) => setTimeout(r, 500));

  try {
    // static file serving
    const home = await req("GET", "/");
    check("GET / returns 200", home.status === 200);

    const missing = await req("GET", "/does-not-exist.js");
    check("unknown static path returns 404", missing.status === 404);

    // room lifecycle
    const created = await req("POST", "/api/room/create");
    check("POST /api/room/create returns 200", created.status === 200);
    check("create response includes roomId", !!created.json?.roomId);
    const roomId = created.json.roomId;

    const fetched = await req("GET", `/api/room/${roomId}`);
    check("GET /api/room/:id returns 200", fetched.status === 200);
    check("new room starts in waiting status", fetched.json?.room?.status === "waiting");

    const missingRoom = await req("GET", "/api/room/doesnotexist");
    check("unknown room returns 404", missingRoom.status === 404);

    // uploads for both partners, all 4 slots
    for (const role of ["A", "B"]) {
      for (let slot = 0; slot < 4; slot++) {
        const up = await req("POST", `/api/room/${roomId}/upload`, { role, slot, image: TINY_PNG });
        check(`upload role=${role} slot=${slot} returns 200`, up.status === 200);
      }
    }
    const afterUploads = await req("GET", `/api/room/${roomId}`);
    check("room status is composing once both sides are full", afterUploads.json?.room?.status === "composing");

    const badUpload = await req("POST", `/api/room/${roomId}/upload`, { role: "C", slot: 0, image: TINY_PNG });
    check("invalid role rejected with 400", badUpload.status === 400);

    // save + strip retrieval
    const saved = await req("POST", `/api/room/${roomId}/save`, { image: TINY_PNG, frame: "pink", filter: "glow", stickers: [] });
    check("POST save returns 200", saved.status === 200);

    const strip = await req("GET", `/api/strip/${roomId}`);
    check("GET strip returns 200 after save", strip.status === 200);
    check("strip response is a PNG buffer", strip.raw.slice(0, 8).toString("hex") === "89504e470d0a1a0a");

    const notReady = await req("GET", "/api/strip/anotherroom");
    check("strip for unsaved room returns 404", notReady.status === 404);
  } catch (e) {
    console.error("Verification crashed:", e);
    failures++;
  } finally {
    server.kill();
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
