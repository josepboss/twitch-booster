const express = require("express");
const axios = require("axios");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3080;

// DB setup
const db = new Database(path.join(__dirname, "history.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    batches_done INTEGER NOT NULL,
    total_batches INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL
  )
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// SMMCost API v2
const SMMCOST_API = "https://smmcost.com/api/v2";
const SERVICE_ID = 3831; // ⚠️ Confirm this is the correct Twitch Followers service ID via the services endpoint
const MAX_PER_ORDER = 1000;
const POLL_INTERVAL = 15000;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// ── SSE write queue ─────────────────────────────────────────
let sseWriteQueue = Promise.resolve();
function writeToStream(res, data) {
  if (res.writableEnded) return;
  sseWriteQueue = sseWriteQueue.then(() => {
    return new Promise((resolve) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`, resolve);
    });
  });
}

// ── SMMCost helpers ─────────────────────────────────────────
async function smmRequest(apiKey, params) {
  const body = new URLSearchParams({ key: apiKey, ...params });
  const res = await axios.post(SMMCOST_API, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000
  });
  return res.data;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Save/update history row ──────────────────────────────────
function saveHistory(username, qty, batchesDone, totalBatches, status, startedAt, finishedAt) {
  // Try to update existing row (same username and started_at), otherwise insert
  const existing = db.prepare("SELECT id FROM history WHERE username = ? AND started_at = ?").get(username, startedAt);
  if (existing) {
    db.prepare(`UPDATE history SET batches_done = ?, status = ?, finished_at = ? WHERE id = ?`)
      .run(batchesDone, status, finishedAt, existing.id);
  } else {
    db.prepare(`
      INSERT INTO history (username, quantity, batches_done, total_batches, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(username, qty, batchesDone, totalBatches, status, startedAt, finishedAt);
  }
}

// ── Process a single account (sequential batches) ────────────
async function processAccount(res, apiKey, username, qty, batches, startedAt) {
  writeToStream(res, { type: "account_start", username, batches });

  let batchesDone = 0;
  let accountStatus = "done";

  // Save initial (running) state
  saveHistory(username, qty, 0, batches, "running", startedAt, startedAt);

  for (let i = 1; i <= batches; i++) {
    writeToStream(res, { type: "log", level: "info", msg: `[${username}] placing batch ${i}/${batches} (+${MAX_PER_ORDER} followers)` });

    let order;
    try {
      order = await smmRequest(apiKey, {
        action: "add",
        service: SERVICE_ID,
        link: `https://www.twitch.tv/${username}`,
        quantity: MAX_PER_ORDER
      });
    } catch (e) {
      writeToStream(res, { type: "log", level: "error", msg: `[${username}] batch ${i} — network error: ${e.message}` });
      accountStatus = "error";
      break;
    }

    if (order.error) {
      writeToStream(res, { type: "log", level: "error", msg: `[${username}] batch ${i} — API error: ${order.error}` });
      accountStatus = "error";
      break;
    }

    const orderId = order.order;
    writeToStream(res, { type: "log", level: "success", msg: `[${username}] batch ${i} — order #${orderId} placed, waiting...` });

    // Poll until complete
    let completed = false;
    while (!completed) {
      await sleep(POLL_INTERVAL);
      let status;
      try {
        status = await smmRequest(apiKey, { action: "status", order: orderId });
      } catch {
        writeToStream(res, { type: "log", level: "warn", msg: `[${username}] batch ${i} — poll error, retrying...` });
        continue;
      }
      const s = (status.status || "").toLowerCase();
      writeToStream(res, { type: "log", level: "info", msg: `[${username}] batch ${i} — order #${orderId}: ${s}` });

      if (s === "completed" || s === "partial") {
        completed = true;
      } else if (s === "cancelled" || s === "canceled") {
        writeToStream(res, { type: "log", level: "error", msg: `[${username}] batch ${i} — order cancelled` });
        accountStatus = "error";
        completed = true;
        break;
      }
    }

    if (accountStatus === "error") break;

    batchesDone = i;
    // Save progress after each batch
    saveHistory(username, qty, batchesDone, batches, "running", startedAt, Date.now());
    writeToStream(res, { type: "batch_done", username, batchesDone, totalBatches: batches });
    writeToStream(res, { type: "log", level: "success", msg: `[${username}] batch ${i}/${batches} ✓ completed` });
  }

  const finalStatus = (accountStatus === "done") ? "done" : (accountStatus === "error" ? "error" : "stopped");
  saveHistory(username, qty, batchesDone, batches, finalStatus, startedAt, Date.now());

  if (accountStatus === "done") {
    writeToStream(res, { type: "log", level: "success", msg: `[${username}] ✅ all ${qty} followers done!` });
  }

  writeToStream(res, { type: "account_done", username, status: finalStatus, batchesDone, totalBatches: batches });
}

// ── Main boost route (SSE stream) ───────────────────────────
app.get("/api/boost", async (req, res) => {
  const { apiKey, accounts, quantity } = req.query;

  if (!apiKey || !accounts || !quantity) {
    return res.status(400).json({ error: "Missing params" });
  }

  const usernames = accounts.split(",").map(s => s.trim()).filter(Boolean);
  const qty = parseInt(quantity);
  const batches = qty / MAX_PER_ORDER;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Reset write queue for this connection
  sseWriteQueue = Promise.resolve();

  // Heartbeat to keep connection alive
  const heartbeatTimer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": heartbeat\n\n");
    }
  }, HEARTBEAT_INTERVAL);

  // Cleanup on client disconnect
  req.on("close", () => {
    clearInterval(heartbeatTimer);
    // Optionally mark all running accounts as stopped (they'll be saved on next batch completion)
    // But we let the processes continue and update DB
  });

  writeToStream(res, { type: "start", total: usernames.length, qty });

  // Start all accounts concurrently
  const promises = usernames.map(username => {
    const startedAt = Date.now();
    return processAccount(res, apiKey, username, qty, batches, startedAt);
  });

  await Promise.all(promises);

  clearInterval(heartbeatTimer);
  writeToStream(res, { type: "all_done" });
  res.end();
});

// ── History routes ───────────────────────────────────────────
app.get("/api/history", (req, res) => {
  const rows = db.prepare("SELECT * FROM history ORDER BY finished_at DESC LIMIT 500").all();
  res.json(rows);
});

app.delete("/api/history", (req, res) => {
  db.prepare("DELETE FROM history").run();
  res.json({ ok: true });
});

app.delete("/api/history/:id", (req, res) => {
  db.prepare("DELETE FROM history WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/history/stats", (req, res) => {
  const total = db.prepare("SELECT COUNT(*) as c FROM history").get().c;
  const done = db.prepare("SELECT COUNT(*) as c FROM history WHERE status='done'").get().c;
  const followers = db.prepare("SELECT COALESCE(SUM(quantity),0) as s FROM history WHERE status='done'").get().s;
  const unique = db.prepare("SELECT COUNT(DISTINCT username) as c FROM history").get().c;
  res.json({ total, done, followers, unique });
});

app.listen(PORT, () => {
  console.log(`Twitch Booster running on port ${PORT}`);
});