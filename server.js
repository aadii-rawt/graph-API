/* eslint-disable no-console */
const express = require('express');
const morgan  = require('morgan');
const crypto  = require('crypto');
const axios   = require('axios');
const util    = require('util');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

/* =================== ENV =================== */
const {
  PORT = 3000,
  VERIFY_TOKEN,
  APP_SECRET,
  PAGE_ACCESS_TOKEN,
  AUTO_REPLY_MESSAGE = 'Thanks for the comment! 🙌',
  IG_BUSINESS_ID,
  IG_USERNAME,
  SIG_DEBUG = '0',

  // Logging toggles (set "1" to enable)
  LOG_HEADERS = '1',       // log request headers
  LOG_RAW = '1',           // log raw webhook payload (string form)
  LOG_PARSED = '1',        // log parsed JSON (pretty)
  LOG_AXIOS = '1',         // log axios request/response
  MAX_LOG_BYTES = '1048576'// 1 MB cap for payload log
} = process.env;

const MAX_BYTES = Number(MAX_LOG_BYTES) || 1048576;

/* =========================================================
   CORS (open for your tests; not necessary for Meta)
========================================================= */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.header('Access-Control-Request-Headers') || '*'
  );
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/health', express.json());
app.use('/privacy-policy', express.json());
app.use(morgan('tiny'));

/* =========================================================
   Axios instance + logging interceptors
========================================================= */
const http = axios.create({
  timeout: 30000,
  validateStatus: () => true, // we'll throw manually on non-2xx
});

// request logger
http.interceptors.request.use((config) => {
  if (LOG_AXIOS === '1') {
    const bodyPreview = bodyToString(config.data, MAX_BYTES);
    console.log('⬆️  AXIOS REQUEST', {
      method: config.method?.toUpperCase(),
      url: config.url,
      params: config.params,
      headers: config.headers,
      dataBytes: bodyPreview.length,
      data: bodyPreview,
    });
  }
  return config;
});

// response logger
http.interceptors.response.use((res) => {
  if (LOG_AXIOS === '1') {
    const dataPreview = bodyToString(res.data, MAX_BYTES);
    console.log('⬇️  AXIOS RESPONSE', {
      status: res.status,
      statusText: res.statusText,
      url: res.config?.url,
      headers: res.headers,
      dataBytes: dataPreview.length,
      data: dataPreview,
    });
  }
  return res;
});

/* =========================================================
   In-memory de-dupe for comment IDs
========================================================= */
const seenCommentIds = new Set();

/* =========================================================
   Optionally resolve our own IG username (avoid self replies)
========================================================= */
let SELF_USERNAME = IG_USERNAME || null;
(async () => {
  try {
    if (!SELF_USERNAME && IG_BUSINESS_ID && PAGE_ACCESS_TOKEN) {
      const r = await http.get(`https://graph.facebook.com/v23.0/${IG_BUSINESS_ID}`, {
        params: { fields: 'username', access_token: PAGE_ACCESS_TOKEN }
      });
      if (r.status >= 200 && r.status < 300 && r.data?.username) {
        SELF_USERNAME = String(r.data.username);
        console.log('👤 Detected IG username:', SELF_USERNAME);
      }
    }
  } catch (e) {
    console.warn('Could not detect username:', e?.message);
  }
})();

/* =========================================================
   Health + Policy
========================================================= */
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/privacy-policy', (_req, res) => {
  res.type('html').send(PRIVACY_POLICY_HTML());
});

/* =========================================================
   Webhook verification (GET)
========================================================= */
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.type('html').send(HELLO_HTML('GET'));
});

/* =========================================================
   Webhook receiver (POST) — keep RAW body for HMAC
========================================================= */
app.post('/webhook', express.raw({ type: '*/*', inflate: false, limit: '5mb' }), async (req, res) => {
  try {
    const rawBuf    = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const sig256    = req.get('x-hub-signature-256');
    const sig1      = req.get('x-hub-signature');
    const headerSig = sig256 || sig1;

    // --- FULL REQUEST LOG ---
    logWebhookRequest(req, rawBuf, headerSig);

    const valid = verifyMetaSignature(headerSig, rawBuf, APP_SECRET);

    if (SIG_DEBUG === '1') {
      const algo = headerSig ? headerSig.split('=')[0] : 'none';
      const bodyPreview = rawBuf.toString('utf8').slice(0, 160).replace(/\s+/g, ' ');
      console.log('🔎 SigDebug ->', { algo, rawLen: rawBuf.length, valid });
      console.log('🔎 BodySample:', bodyPreview);
    }

    if (!APP_SECRET || !valid) {
      console.warn('❌ Invalid or missing signature on webhook POST');
      return res.sendStatus(401);
    }

    // ACK fast
    res.sendStatus(200);

    // Process after ack
    await processWebhookBuffer(rawBuf);
  } catch (err) {
    console.error('Webhook handler error:', err);
    try { res.sendStatus(200); } catch {}
  }
});

/* =========================================================
   Start server
========================================================= */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

/* ====================== Helpers ====================== */

function verifyMetaSignature(headerSig, rawBodyBuf, appSecret) {
  if (!appSecret || !headerSig || !rawBodyBuf) return false;
  const parts = String(headerSig).split('=');
  if (parts.length !== 2) return false;
  const algo = parts[0]; // sha256 or sha1
  const theirHex = parts[1];

  let hmacHex;
  try {
    hmacHex = crypto.createHmac(algo, appSecret.trim()).update(rawBodyBuf).digest('hex');
  } catch {
    hmacHex = crypto.createHmac('sha256', appSecret.trim()).update(rawBodyBuf).digest('hex');
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(theirHex), Buffer.from(hmacHex));
  } catch {
    return false;
  }
}

function bodyToString(data, cap = 1_000_000) {
  if (data == null) return '';
  try {
    // Buffers or strings
    if (Buffer.isBuffer(data)) return data.toString('utf8').slice(0, cap);
    if (typeof data === 'string') return data.slice(0, cap);
    // Objects: pretty JSON (no truncation by util.inspect depth)
    const s = JSON.stringify(data);
    // If already long string, cap by bytes
    return s.length > cap ? s.slice(0, cap) + ` …(truncated ${s.length - cap} chars)` : s;
  } catch {
    try {
      const s = util.inspect(data, { depth: null, maxArrayLength: null, breakLength: 120 });
      return s.length > cap ? s.slice(0, cap) + ` …(truncated)` : s;
    } catch {
      return String(data);
    }
  }
}

function logWebhookRequest(req, rawBuf, headerSig) {
  const headers = LOG_HEADERS === '1' ? req.headers : undefined;
  const rawText = LOG_RAW === '1' ? rawBuf.toString('utf8').slice(0, MAX_BYTES) : undefined;

  console.log('📥 WEBHOOK REQUEST');
  console.log({
    method: req.method,
    url: req.originalUrl,
    query: req.query,
    sigHeader: headerSig || '(none)',
    rawBytes: rawBuf.length,
    headers
  });

  if (rawText) {
    console.log('📄 RAW BODY:', rawText.length > 0 ? rawText : '(empty)');
  }

  if (LOG_PARSED === '1') {
    try {
      const json = JSON.parse(rawBuf.toString('utf8'));
      console.log('🧩 PARSED JSON:', bodyToString(json, MAX_BYTES));
    } catch (e) {
      console.log('🧩 PARSED JSON: (failed to parse)', e?.message);
    }
  }
}

async function processWebhookBuffer(rawBuf) {
  let body;
  try {
    body = JSON.parse(rawBuf.toString('utf8'));
  } catch (e) {
    console.error('⚠️ Could not parse JSON body:', e?.message);
    return;
  }
  if (!body?.object || !Array.isArray(body.entry)) return;

  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      // ----- Comments -----
      if (change.field === 'comments' && change.value?.id) {
        const commentId = change.value.id;

        // De-dupe
        if (seenCommentIds.has(commentId)) {
          if (SIG_DEBUG === '1') console.log('↩️ already handled', commentId);
          continue;
        }
        seenCommentIds.add(commentId);

        // Get author (avoid self-reply)
        let author = change.value.username || null;
        if (!author) {
          try {
            const r = await http.get(`https://graph.facebook.com/v23.0/${commentId}`, {
              params: { fields: 'username', access_token: PAGE_ACCESS_TOKEN }
            });
            if (r.status >= 200 && r.status < 300) author = r.data?.username || null;
          } catch (e) {}
        }
        if (author && SELF_USERNAME && author.toLowerCase() === SELF_USERNAME.toLowerCase()) {
          if (SIG_DEBUG === '1') console.log('🛑 own comment; skipping reply');
          continue;
        }

        const text = change.value?.text;
        console.log('📝 New comment (FULL):', bodyToString(change, MAX_BYTES));

        // Example public reply (change to private reply if you prefer)
        try {
          await sendPublicReply(commentId, AUTO_REPLY_MESSAGE);
          console.log('💬 Public reply posted to', commentId);
        } catch (err) {
          console.error('Public reply failed:', errToString(err));
        }
      }

      // ----- Messages (DM) -----
      if (change.field === 'messages') {
        console.log('📨 DM event (FULL):', bodyToString(change, MAX_BYTES));
      }
    }
  }
}

async function sendPublicReply(commentId, message) {
  const url = `https://graph.facebook.com/v23.0/${commentId}/replies`;
  const body = new URLSearchParams({ message, access_token: PAGE_ACCESS_TOKEN });
  const r = await http.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`HTTP ${r.status} ${r.statusText} — ${bodyToString(r.data, 10000)}`);
  }
}

async function sendPrivateReply(commentId, message) {
  const url = `https://graph.facebook.com/v23.0/${commentId}/private_replies`;
  const body = new URLSearchParams({ message, access_token: PAGE_ACCESS_TOKEN });
  const r = await http.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`HTTP ${r.status} ${r.statusText} — ${bodyToString(r.data, 10000)}`);
  }
}

function errToString(err) {
  if (err?.response) {
    return `HTTP ${err.response.status} ${err.response.statusText} — ${bodyToString(err.response.data, 10000)}`;
  }
  return String(err?.message || err);
}

function HELLO_HTML(method) {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Webhook ${method}</title>
  <style>body{font-family:system-ui,Arial;padding:24px}</style></head>
  <body><h1>This is ${method} Request, Hello Webhook!</h1></body></html>`;
}

function PRIVACY_POLICY_HTML() {
  const today = new Date().toISOString().slice(0,10);
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Privacy Policy</title>
  <style>body{font-family:system-ui,Arial;padding:24px;line-height:1.6}</style></head>
  <body><h1>Privacy Policy</h1>
  <p>Effective date: <strong>${today}</strong></p>
  <p>We collect Instagram data (comments, messages, media metadata) you authorize.</p>
  <p>We use it to send automated replies and provide services. We do not sell data.</p>
  <p>You may revoke permissions anytime from Instagram/Facebook settings.</p>
  <p>Contact: contact@example.com</p></body></html>`;
}
