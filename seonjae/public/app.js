(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    roomId: null,
    role: null,        // 'A' | 'B'
    mySlots: [null, null, null, null],
    partnerSlots: [null, null, null, null],
    currentSlot: 0,
    stream: null,
    filter: "none",
    frame: "lavender",
    stickers: [],       // {id, emoji, xPct, yPct}
    pollTimer: null,
    lastSeenNudgeTs: 0,
  };

  const FILTERS = {
    none: "none",
    retro: "sepia(0.35) contrast(1.15) saturate(1.25)",
    peach: "sepia(0.18) saturate(1.35) hue-rotate(-8deg) brightness(1.06)",
    grayscale: "grayscale(1) contrast(1.08)",
    cold: "saturate(1.1) hue-rotate(15deg) brightness(1.03) contrast(1.05)",
    glow: "brightness(1.12) contrast(0.94) saturate(1.18)",
  };

  const FRAME_COLORS = {
    lavender: "#E8DBFC",
    pink: "#FFD6EC",
    cream: "#FBF3E7",
    plum: "#3E2A4D",
  };

  // ---------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  function showView(name) {
    $all(".view").forEach((v) => v.classList.remove("active"));
    $(`#view-${name}`).classList.add("active");
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    return res.json();
  }

  // ---------------------------------------------------------------------
  // Landing → Create / Join room
  // ---------------------------------------------------------------------
  $("#btn-create").addEventListener("click", async () => {
    try {
      const { roomId } = await api("/api/room/create", { method: "POST" });
      state.roomId = roomId;
      state.role = "A";
      enterLobby();
    } catch (e) {
      toast(e.message);
    }
  });

  $("#btn-join").addEventListener("click", () => {
    $("#join-inline").classList.toggle("hidden");
    $("#join-code").focus();
  });

  $("#btn-join-go").addEventListener("click", joinRoom);
  $("#join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });

  async function joinRoom() {
    const code = $("#join-code").value.trim();
    if (!code) return toast("Enter a room code first");
    try {
      await api(`/api/room/${code}`);
      state.roomId = code;
      state.role = "B";
      enterLobby();
    } catch (e) {
      toast("That room code wasn't found");
    }
  }

  // Auto-join via ?room=CODE link
  (function checkUrlParams() {
    const params = new URLSearchParams(location.search);
    const room = params.get("room");
    if (room) {
      $("#join-code").value = room;
      $("#join-inline").classList.remove("hidden");
    }
  })();

  // ---------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------
  function enterLobby() {
    showView("lobby");
    $("#lobby-code").textContent = state.roomId;
    const link = `${location.origin}${location.pathname}?room=${state.roomId}`;
    $("#lobby-link").value = link;
    pollLobby();
  }

  $("#reminder-email").addEventListener("change", async (e) => {
    const email = e.target.value.trim();
    if (!email) return;
    try {
      await api(`/api/room/${state.roomId}/email`, {
        method: "POST",
        body: JSON.stringify({ role: state.role, email }),
      });
      toast("Saved — you'll get a nudge at 5pm KST");
    } catch (err) {
      toast("Couldn't save that email — try again");
    }
  });

  $("#btn-copy-code").addEventListener("click", () => copyText(state.roomId));
  $("#btn-copy-link").addEventListener("click", () => copyText($("#lobby-link").value));
  function copyText(text) {
    navigator.clipboard?.writeText(text).then(() => toast("Copied!")).catch(() => toast("Copy failed — select manually"));
  }

  function pollLobby() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      try {
        const { room } = await api(`/api/room/${state.roomId}`);
        const partnerSlots = state.role === "A" ? room.slotsB : room.slotsA;
        if (partnerSlots.some(Boolean)) {
          $("#lobby-status").textContent = "Your partner is in the booth too! 💫";
        }
      } catch (e) { /* room may not exist yet on very first tick — ignore */ }
    }, 2000);
  }

  $("#btn-lobby-continue").addEventListener("click", () => {
    clearInterval(state.pollTimer);
    enterBooth();
  });

  // ---------------------------------------------------------------------
  // Photobooth
  // ---------------------------------------------------------------------
  async function enterBooth() {
    showView("photobooth");
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      $("#video").srcObject = state.stream;
    } catch (e) {
      toast("Camera access is needed to take your cuts");
    }
    if (window.Notification && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    pollBoothSync();
  }

  $("#btn-nudge").addEventListener("click", async () => {
    try {
      await api(`/api/room/${state.roomId}/nudge`, {
        method: "POST",
        body: JSON.stringify({ role: state.role }),
      });
      toast("Sent! They'll get a nudge 💌");
    } catch (e) {
      toast("Couldn't send the nudge — try again");
    }
  });

  function playChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1175, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.35);
    } catch (e) { /* audio not available — silently skip */ }
  }

  function notifyNudge() {
    toast("💌 Your partner is ready to take a photo!");
    playChime();
    if (window.Notification && Notification.permission === "granted") {
      new Notification("Seonjae 손재", { body: "Your partner is ready to take a photo!" });
    }
  }

  function pollBoothSync() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      try {
        const { room } = await api(`/api/room/${state.roomId}`);
        state.partnerSlots = state.role === "A" ? room.slotsB : room.slotsA;
        renderMiniSlots("slots-partner", state.partnerSlots);
        const bothFull = room.slotsA.every(Boolean) && room.slotsB.every(Boolean);
        $("#btn-to-editor").disabled = !bothFull;
        $("#editor-hint").textContent = bothFull
          ? "Both strips are ready — compose them together."
          : "Waiting on 8 photos total — 4 from each of you.";

        if (room.nudge && room.nudge.from !== state.role && room.nudge.ts > state.lastSeenNudgeTs) {
          state.lastSeenNudgeTs = room.nudge.ts;
          notifyNudge();
        }
      } catch (e) { /* ignore transient poll errors */ }
    }, 2000);
  }

  function renderMiniSlots(containerId, slots) {
    const container = $(`#${containerId}`);
    slots.forEach((dataUrl, i) => {
      const el = container.querySelector(`[data-slot="${i}"]`);
      if (dataUrl && !el.classList.contains("filled")) {
        el.style.backgroundImage = `url(${dataUrl})`;
        el.style.backgroundSize = "cover";
        el.classList.add("filled");
      } else if (dataUrl) {
        el.style.backgroundImage = `url(${dataUrl})`;
        el.style.backgroundSize = "cover";
      }
    });
  }

  $("#btn-capture").addEventListener("click", runCountdown);

  async function runCountdown() {
    if (state.currentSlot > 3) return;
    $("#btn-capture").disabled = true;
    const cd = $("#countdown");
    cd.classList.remove("hidden");
    for (let n = 3; n >= 1; n--) {
      cd.textContent = n;
      await sleep(650);
    }
    cd.classList.add("hidden");
    await capturePhoto();
    $("#btn-capture").disabled = false;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function capturePhoto() {
    const video = $("#video");
    const flash = $("#flash-overlay");
    flash.classList.remove("active"); void flash.offsetWidth; flash.classList.add("active");

    const c = document.createElement("canvas");
    c.width = 640; c.height = 480;
    const ctx = c.getContext("2d");
    ctx.translate(c.width, 0); ctx.scale(-1, 1); // mirror to match preview
    ctx.drawImage(video, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", 0.9);

    const slot = state.currentSlot;
    state.mySlots[slot] = dataUrl;
    const el = $(`#slots-mine [data-slot="${slot}"]`);
    el.style.backgroundImage = `url(${dataUrl})`;
    el.style.backgroundSize = "cover";
    el.classList.add("filled");

    state.currentSlot++;
    $("#cut-number").textContent = Math.min(state.currentSlot + 1, 4);
    if (state.currentSlot >= 4) {
      $("#btn-capture").disabled = true;
      $("#btn-capture").querySelector("span:last-of-type")?.remove();
    }

    try {
      await api(`/api/room/${state.roomId}/upload`, {
        method: "POST",
        body: JSON.stringify({ role: state.role, slot, image: dataUrl }),
      });
    } catch (e) {
      toast("Upload failed — check your connection");
    }
  }

  $("#btn-to-editor").addEventListener("click", () => {
    clearInterval(state.pollTimer);
    state.stream?.getTracks().forEach((t) => t.stop());
    enterEditor();
  });

  // ---------------------------------------------------------------------
  // Editor
  // ---------------------------------------------------------------------
  const canvas = $("#canvas");
  const ctx2d = canvas.getContext("2d");
  const ROWS = 4, PAD = 24, GAP = 12, ROW_H = 180, FOOT_H = 108;

  function enterEditor() {
    showView("editor");
    drawCanvas();
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function drawCanvas() {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = FRAME_COLORS[state.frame] || FRAME_COLORS.lavender;
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);

    const cellW = (canvas.width - PAD * 2 - GAP) / 2;
    ctx2d.filter = FILTERS[state.filter] || "none";

    for (let i = 0; i < ROWS; i++) {
      const y = PAD + i * (ROW_H + GAP);
      const [imgA, imgB] = await Promise.all([loadImage(state.mySlotFor("A", i)), loadImage(state.mySlotFor("B", i))]);
      drawCover(imgA, PAD, y, cellW, ROW_H);
      drawCover(imgB, PAD + cellW + GAP, y, cellW, ROW_H);
    }
    ctx2d.filter = "none";

    // footer branding
    const isDark = state.frame === "plum";
    ctx2d.fillStyle = isDark ? "#F2E7FA" : "#3E2A4D";
    ctx2d.font = "22px 'Gowun Dodum', sans-serif";
    ctx2d.textAlign = "center";
    ctx2d.fillText("손재 · seonjae", canvas.width / 2, canvas.height - FOOT_H / 2 + 6);

    // stickers
    state.stickers.forEach((s) => {
      ctx2d.font = "40px serif";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "middle";
      ctx2d.fillText(s.emoji, s.xPct * canvas.width, s.yPct * canvas.height);
    });
  }

  function drawCover(img, x, y, w, h) {
    if (!img) {
      ctx2d.fillStyle = "rgba(255,255,255,0.5)";
      ctx2d.fillRect(x, y, w, h);
      return;
    }
    const ir = img.width / img.height, tr = w / h;
    let sx, sy, sw, sh;
    if (ir > tr) { sh = img.height; sw = sh * tr; sx = (img.width - sw) / 2; sy = 0; }
    else { sw = img.width; sh = sw / tr; sx = 0; sy = (img.height - sh) / 2; }
    ctx2d.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  state.mySlotFor = function (role, i) {
    if (role === "A") return this.role === "A" ? this.mySlots[i] : this.partnerSlots[i];
    return this.role === "B" ? this.mySlots[i] : this.partnerSlots[i];
  };

  // Frame swatches
  $all(".swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      $all(".swatch").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.frame = btn.dataset.frame;
      drawCanvas();
    });
  });
  $(".swatch")?.classList.add("active");

  // Filter select
  $("#filter-select").addEventListener("change", (e) => {
    state.filter = e.target.value;
    drawCanvas();
  });

  // Stickers: add + drag
  let stickerSeq = 0;
  $all(".sticker-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = `s${stickerSeq++}`;
      state.stickers.push({ id, emoji: btn.dataset.sticker, xPct: 0.5, yPct: 0.5 });
      mountStickerEl(id, btn.dataset.sticker, 0.5, 0.5);
      drawCanvas();
    });
  });

  function mountStickerEl(id, emoji, xPct, yPct) {
    const overlay = $("#sticker-overlay");
    const el = document.createElement("div");
    el.className = "sticker-item";
    el.textContent = emoji;
    el.dataset.id = id;
    positionStickerEl(el, xPct, yPct);
    overlay.appendChild(el);
    makeDraggable(el, id);
  }

  function positionStickerEl(el, xPct, yPct) {
    el.style.left = `${xPct * 100}%`;
    el.style.top = `${yPct * 100}%`;
  }

  function makeDraggable(el, id) {
    let dragging = false;
    el.addEventListener("pointerdown", (e) => {
      dragging = true;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const rect = $("#sticker-overlay").getBoundingClientRect();
      const xPct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const yPct = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
      positionStickerEl(el, xPct, yPct);
      const s = state.stickers.find((s) => s.id === id);
      if (s) { s.xPct = xPct; s.yPct = yPct; }
    });
    el.addEventListener("pointerup", () => { dragging = false; drawCanvas(); });
  }

  // Save
  $("#btn-save-strip").addEventListener("click", async () => {
    await drawCanvas();
    const dataUrl = canvas.toDataURL("image/png");
    try {
      await api(`/api/room/${state.roomId}/save`, {
        method: "POST",
        body: JSON.stringify({ image: dataUrl, frame: state.frame, filter: state.filter, stickers: state.stickers }),
      });
      enterShare(dataUrl);
    } catch (e) {
      toast("Couldn't save the strip — try again");
    }
  });

  // ---------------------------------------------------------------------
  // Share
  // ---------------------------------------------------------------------
  function enterShare(dataUrl) {
    showView("share");
    $("#final-strip-img").src = dataUrl;
    $("#btn-download").href = dataUrl;

    const qrBox = $("#qr-box");
    qrBox.innerHTML = "";
    const strollUrl = `${location.origin}/api/strip/${state.roomId}`;
    if (window.QRCode) {
      new QRCode(qrBox, { text: strollUrl, width: 140, height: 140, colorDark: "#3E2A4D", colorLight: "#ffffff" });
    } else {
      qrBox.textContent = strollUrl;
    }
  }
})();
