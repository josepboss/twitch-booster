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

const SMMCOST_API = "https://smmcost.com/api";
const SERVICE_ID = 3831;
const MAX_PER_ORDER = 1000;
const POLL_INTERVAL = 15000;

// ── SSE helper ──────────────────────────────────────────────
function sendEvent(res, data) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
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

  sendEvent(res, { type: "start", total: usernames.length, qty });

  for (const username of usernames) {
    const startedAt = Date.now();
    sendEvent(res, { type: "account_start", username, batches });

    let batchesDone = 0;
    let accountStatus = "done";

    for (let i = 1; i <= batches; i++) {
      sendEvent(res, { type: "log", level: "info", msg: `[${username}] placing batch ${i}/${batches} (+${MAX_PER_ORDER} followers)` });

      let order;
      try {
        order = await smmRequest(apiKey, {
          action: "add",
          service: SERVICE_ID,
          link: `https://www.twitch.tv/${username}`,
          quantity: MAX_PER_ORDER
        });
      } catch (e) {
        sendEvent(res, { type: "log", level: "error", msg: `[${username}] batch ${i} — network error: ${e.message}` });
        accountStatus = "error";
        break;
      }

      if (order.error) {
        sendEvent(res, { type: "log", level: "error", msg: `[${username}] batch ${i} — API error: ${order.error}` });
        accountStatus = "error";
        break;
      }

      const orderId = order.order;
      sendEvent(res, { type: "log", level: "success", msg: `[${username}] batch ${i} — order #${orderId} placed, waiting...` });

      // Poll until complete
      let completed = false;
      while (!completed) {
        await sleep(POLL_INTERVAL);
        let status;
        try {
          status = await smmRequest(apiKey, { action: "status", order: orderId });
        } catch {
          sendEvent(res, { type: "log", level: "warn", msg: `[${username}] batch ${i} — poll error, retrying...` });
          continue;
        }
        const s = (status.status || "").toLowerCase();
        sendEvent(res, { type: "log", level: "info", msg: `[${username}] batch ${i} — order #${orderId}: ${s}` });

        if (s === "completed" || s === "partial") {
          completed = true;
        } else if (s === "cancelled" || s === "canceled") {
          sendEvent(res, { type: "log", level: "error", msg: `[${username}] batch ${i} — order cancelled` });
          accountStatus = "error";
          completed = true;
          break;
        }
      }

      if (accountStatus === "error") break;

      batchesDone = i;
      sendEvent(res, { type: "batch_done", username, batchesDone, totalBatches: batches });
      sendEvent(res, { type: "log", level: "success", msg: `[${username}] batch ${i}/${batches} ✓ completed` });
    }

    if (accountStatus === "done") {
      sendEvent(res, { type: "log", level: "success", msg: `[${username}] ✅ all ${qty} followers done!` });
    }

    // Save to DB
    db.prepare(`
      INSERT INTO history (username, quantity, batches_done, total_batches, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(username, qty, batchesDone, batches, accountStatus, startedAt, Date.now());

    sendEvent(res, { type: "account_done", username, status: accountStatus, batchesDone, totalBatches: batches });
  }

  sendEvent(res, { type: "all_done" });
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
