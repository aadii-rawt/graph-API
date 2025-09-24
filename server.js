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
  AUTO_REPLY_MESSAGE = 'Thanks for the comment! 🙌 Reply VIEW to get our catalog.',
  IG_BUSINESS_ID,
  IG_USERNAME,
  SIG_DEBUG = '0',

  // optional: DM carousel config
  CATALOG_URL = 'https://example.com',
  CAROUSEL_IMAGE_URL = 'https://via.placeholder.com/600x600.png?text=Catalog',

  // Logging toggles (set "1" to enable)
  LOG_HEADERS = '1',
  LOG_RAW = '1',
  LOG_PARSED = '1',
  LOG_AXIOS = '1',
  MAX_LOG_BYTES = '1048576' // 1 MB cap
} = process.env;

const MAX_BYTES = Number(MAX_LOG_BYTES) || 1048576;

/* =========================================================
   CORS (open for your tests)
========================================================= */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.header('Access-Control-Request-Headers') || '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/health', express.json());
app.use('/privacy-policy', express.json());
app.use(morgan('tiny'));

/* =========================================================
   Axios instance + logging interceptors
========================================================= */
const http = axios.create({ timeout: 30000, validateStatus: () => true });

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
   De-dupe for comment IDs
========================================================= */
const seenCommentIds = new Set();

/* =========================================================
   Our own IG username (avoid self replies)
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
app.get('/privacy-policy', (_req, res) => res.type('html').send(PRIVACY_POLICY_HTML()));

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
   Webhook receiver (POST) — RAW body for HMAC
========================================================= */
app.post('/webhook', express.raw({ type: '*/*', inflate: false, limit: '5mb' }), async (req, res) => {
  try {
    const rawBuf    = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const sig256    = req.get('x-hub-signature-256');
    const sig1      = req.get('x-hub-signature');
    const headerSig = (sig256 || sig1 || '').replace(/"/g, '');

    // --- FULL REQUEST LOG ---
    logWebhookRequest(req, rawBuf, headerSig);

    const valid = verifyMetaSignature(headerSig, rawBuf, (APP_SECRET || '').trim());

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

    res.sendStatus(200); // ACK fast
    await processWebhookBuffer(rawBuf);
  } catch (err) {
    console.error('Webhook handler error:', err);
    try { res.sendStatus(200); } catch {}
  }
});

/* =========================================================
   Start server
========================================================= */
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

/* ====================== Helpers ====================== */

function verifyMetaSignature(headerSig, rawBodyBuf, appSecret) {
  if (!appSecret || !headerSig || !rawBodyBuf) return false;
  const [algo, theirHex] = String(headerSig).split('=');
  if (!algo || !theirHex) return false;
  let hmacHex;
  try { hmacHex = crypto.createHmac(algo, appSecret).update(rawBodyBuf).digest('hex'); }
  catch { hmacHex = crypto.createHmac('sha256', appSecret).update(rawBodyBuf).digest('hex'); }
  try { return crypto.timingSafeEqual(Buffer.from(theirHex), Buffer.from(hmacHex)); }
  catch { return false; }
}

function bodyToString(data, cap = 1_000_000) {
  if (data == null) return '';
  try {
    if (Buffer.isBuffer(data)) return data.toString('utf8').slice(0, cap);
    if (typeof data === 'string') return data.slice(0, cap);
    const s = JSON.stringify(data);
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
  console.log({ method: req.method, url: req.originalUrl, query: req.query, sigHeader: headerSig || '(none)', rawBytes: rawBuf.length, headers });
  if (rawText) console.log('📄 RAW BODY:', rawText.length > 0 ? rawText : '(empty)');
  if (LOG_PARSED === '1') {
    try { console.log('🧩 PARSED JSON:', bodyToString(JSON.parse(rawBuf.toString('utf8')), MAX_BYTES)); }
    catch (e) { console.log('🧩 PARSED JSON: (failed to parse)', e?.message); }
  }
}

/* ================== Core processing ================== */
async function processWebhookBuffer(rawBuf) {
  let body;
  try { body = JSON.parse(rawBuf.toString('utf8')); }
  catch (e) { console.error('⚠️ Could not parse JSON body:', e?.message); return; }
  if (!body?.object || !Array.isArray(body.entry)) return;

  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      /* ===== IG COMMENTS ===== */
      if (change.field === 'comments' && change.value?.id) {
        const commentId = change.value.id;

        // De-dupe
        if (seenCommentIds.has(commentId)) { if (SIG_DEBUG === '1') console.log('↩️ already handled', commentId); continue; }
        seenCommentIds.add(commentId);

        // Full details of the comment (user + media + parent)
        await logCommentDetails(commentId);

        // Try DM using the commenter IGSID if present in webhook (may fail if thread not allowed)
        const igsidFromWebhook = change.value?.from?.id || null;
        if (igsidFromWebhook) {
          console.log('👤 commenter IGSID from webhook:', igsidFromWebhook);
          try {
            await sendDmText(igsidFromWebhook, 'Thanks for your comment! Here is our catalog: ' + CATALOG_URL);
            console.log('📩 DM sent to', igsidFromWebhook);
          } catch (e) {
            console.error('DM from comment failed (expected if no thread yet):', errToString(e));
          }
        }

        // Guaranteed: private reply to TOP-LEVEL comment (lands in inbox)
        try {
          await privateReplyTop(commentId, AUTO_REPLY_MESSAGE);
          console.log('✉️ Private reply sent (top-level) for', commentId);
        } catch (e) {
          console.error('Private reply failed:', errToString(e));
        }
      }

      /* ===== IG MESSAGES (DM) ===== */
      if (change.field === 'messages') {
        const msgs = change.value?.messages || [];
        for (const m of msgs) {
          const fromId = m?.from?.id; // IGSID
          const text   = (m?.text || '').trim();
          if (!fromId) continue;
          if (IG_BUSINESS_ID && String(fromId) === String(IG_BUSINESS_ID)) continue; // ignore ourselves

          // (Optional) fetch limited user details by IGSID (username availability varies)
          try {
            const u = await getIgUserDetailsByIgsid(fromId);
            console.log('👤 DM sender details:', bodyToString(u, MAX_BYTES));
          } catch {}

          console.log('📨 DM received:', { fromId, text });

          // Send a carousel back
          try {
            await sendDmCarousel(fromId);
            console.log('🧾 Carousel sent to', fromId);
          } catch (e) {
            console.error('Send carousel failed:', errToString(e));
          }
        }
      }
    }
  }
}

/* ================== IG Graph helpers ================== */

// Log rich comment details
async function logCommentDetails(commentId) {
  try {
    const r = await http.get(`https://graph.facebook.com/v23.0/${commentId}`, {
      params: {
        fields: 'id,text,username,from{id,username},parent_id,media{id,caption,permalink}',
        access_token: PAGE_ACCESS_TOKEN
      }
    });
    console.log('📝 Comment detail (FULL):', bodyToString(r.data, MAX_BYTES));
  } catch (e) {
    console.error('Read comment failed:', errToString(e));
  }
}

// Private reply must go to the TOP-LEVEL comment
async function privateReplyTop(commentId, message) {
  let targetId = commentId;
  const r = await http.get(`https://graph.facebook.com/v23.0/${commentId}`, {
    params: { fields: 'id,parent_id', access_token: PAGE_ACCESS_TOKEN }
  });
  if (r.status >= 200 && r.status < 300 && r.data?.parent_id) targetId = r.data.parent_id;

  const url  = `https://graph.facebook.com/v23.0/${targetId}/private_replies`;
  const body = new URLSearchParams({ message, access_token: PAGE_ACCESS_TOKEN });
  const pr = await http.post(url, body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (pr.status < 200 || pr.status >= 300) throw new Error(`HTTP ${pr.status} ${pr.statusText} — ${bodyToString(pr.data, 10000)}`);
}

// Send plain text DM (requires valid IGSID + allowed window)
async function sendDmText(igsid, text) {
  const payload = { recipient: { id: igsid }, messaging_type: 'RESPONSE', message: { text } };
  const r = await http.post('https://graph.facebook.com/v23.0/me/messages', payload, {
    params: { access_token: PAGE_ACCESS_TOKEN },
    headers: { 'Content-Type': 'application/json' }
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} ${r.statusText} — ${bodyToString(r.data, 10000)}`);
}

// Send a 1-card carousel DM
async function sendDmCarousel(igsid) {
  const payload = {
    recipient: { id: igsid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [{
            title: 'Browse our products',
            subtitle: 'Tap below to view the full catalog',
            image_url: CAROUSEL_IMAGE_URL || CATALOG_URL,
            default_action: { type: 'web_url', url: CATALOG_URL },
            buttons: [{ type: 'web_url', url: CATALOG_URL, title: 'View all products' }]
          }]
        }
      }
    }
  };
  const r = await http.post('https://graph.facebook.com/v23.0/me/messages', payload, {
    params: { access_token: PAGE_ACCESS_TOKEN },
    headers: { 'Content-Type': 'application/json' }
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} ${r.statusText} — ${bodyToString(r.data, 10000)}`);
}

// Best-effort user details by IGSID (fields available are limited)
async function getIgUserDetailsByIgsid(igsid) {
  const r = await http.get(`https://graph.facebook.com/v23.0/${igsid}`, {
    params: { fields: 'id,username', access_token: PAGE_ACCESS_TOKEN }
  });
  return r.data;
}

function errToString(err) {
  if (err?.response) return `HTTP ${err.response.status} ${err.response.statusText} — ${bodyToString(err.response.data, 10000)}`;
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
