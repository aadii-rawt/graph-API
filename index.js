/* eslint-disable no-console */
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");

const app = express();
app.set("trust proxy", 1);

/* =========================
 * CORS (single middleware)
 * ========================= */
const FRONTENDS =
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const DEFAULT_ALLOWED = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  // add prod here or via env:
  // "https://your-frontend.com",
];

const ALLOWED = FRONTENDS.length ? FRONTENDS : DEFAULT_ALLOWED;

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // same-origin / curl
      return ALLOWED.includes(origin) ? cb(null, true) : cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false, // set to true if you plan to use cross-site cookies
  })
);
// Express 5: regex instead of '*'
app.options(/.*/, cors());

/* =========================
 * Middleware
 * ========================= */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("tiny"));

/* =========================
 * Mongo
 * ========================= */
const MONGO_URI = process.env.MONGO_URI;
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Mongo connected"))
  .catch((err) => {
    console.error("❌ Mongo connection error:", err.message || err);
    process.exit(1);
  });

/* =========================
 * IG media helper (Display)
 * ========================= */
const IG_BASIC_TOKEN = process.env.IG_BASIC_TOKEN;

// tiny cache to avoid rate
const cache = new Map();
const setCache = (key, data, ttlMs = 60_000) =>
  cache.set(key, { data, exp: Date.now() + ttlMs });
const getCache = (key) => {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  if (hit) cache.delete(key);
  return null;
};

function normalizeMediaItem(item) {
  const mediaType = item.media_type;
  const thumb = item.thumbnail_url || item.media_url || null;
  const imageLikeUrl =
    mediaType === "VIDEO" ? item.thumbnail_url || null : item.media_url || null;

  return {
    id: item.id,
    caption: item.caption || "",
    media_type: mediaType,
    media_url: item.media_url || null,
    thumbnail_url: thumb,
    image_like_url: imageLikeUrl,
    permalink: item.permalink,
    timestamp: item.timestamp,
  };
}

async function igGet(path, params = {}) {
  const r = await axios.get(`https://graph.instagram.com/v21.0/${path}`, {
    params: { access_token: IG_BASIC_TOKEN, ...params },
    timeout: 30000,
    validateStatus: () => true,
  });
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`IG ${r.status} ${r.statusText}: ${JSON.stringify(r.data)}`);
}

/* =========================
 * Routes — IG media helpers
 * ========================= */
app.get("/api/ig/me", async (_req, res) => {
  try {
    const cacheKey = "me";
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const data = await igGet("me", {
      fields: "id,username,account_type,media_count",
    });
    setCache(cacheKey, data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/ig/media", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 25), 100);
    const after = req.query.after || undefined;

    const cacheKey = `media:${limit}:${after || "first"}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const fields = [
      "id",
      "caption",
      "media_type",
      "media_url",
      "thumbnail_url",
      "permalink",
      "timestamp",
    ].join(",");

    const data = await igGet("me/media", { fields, limit, after });
    const items = Array.isArray(data.data)
      ? data.data.map(normalizeMediaItem)
      : [];

    const payload = { items, paging: data.paging || null };
    setCache(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/ig/media/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const cacheKey = `media:${id}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const fields =
      "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
    const raw = await igGet(id, { fields });
    const item = normalizeMediaItem(raw);
    setCache(cacheKey, item);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* =========================
 * App routes (your features)
 * ========================= */
// NOTE: you said you created the folders/files already.
// These will point to the files we defined earlier.
app.use("/api/automations", require("./routes/automationRoute"));
app.use("/webhook", require("./routes/webhookRoute"));

/* =========================
 * Health + 404 + error
 * ========================= */
app.get("/health", (_req, res) => res.json({ ok: true }));

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// central error handler (keeps responses tidy)
app.use((err, _req, res, _next) => {
  const msg = err?.message || "Server error";
  // surface CORS origin errors nicely
  if (msg.includes("Not allowed by CORS")) {
    return res.status(403).json({ error: msg });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: msg });
});

/* =========================
 * Start
 * ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 API running on http://localhost:${PORT}`)
);
