// server.js
const express = require('express');
const morgan  = require('morgan');
const crypto  = require('crypto');
const axios   = require('axios');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

const {
  PORT = 3000,
  VERIFY_TOKEN,
  APP_SECRET,
  PAGE_ACCESS_TOKEN,
  AUTO_REPLY_MESSAGE = 'Thanks for the comment! Reply VIEW to get our catalog. Or visit https://aditya.dotdazzle.in',
  CATALOG_URL = 'https://aditya.dotdazzle.in',
  CAROUSEL_IMAGE_URL = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSc7W0Q9VBl3M1sy3m1JyNAskLGHmsLb9iyRA&s',
  IG_BUSINESS_ID,
  IG_USERNAME,
  SIG_DEBUG = '0',
} = process.env;

/* ----------------- open CORS for convenience ----------------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.header('Access-Control-Request-Headers') || '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(morgan('tiny'));

/* ----------------- simple pages ----------------- */
app.get('/', (_req, res) => res.type('html').send(helloHTML('GET')));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/privacy-policy', (_req, res) => res.type('html').send(privacyHTML()));

/* ----------------- webhook verify (GET) ----------------- */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ----------------- webhook receive (POST) ----------------- */
/* IMPORTANT: raw body here to match Meta signature exactly.  */
/* Put this route BEFORE any json/body parser.                */
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const headerSig = req.get('x-hub-signature-256') || req.get('x-hub-signature');
  const rawBuf    = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');

  // verify signature
  if (!verifySig(headerSig, rawBuf, APP_SECRET)) {
    if (SIG_DEBUG === '1') {
      const [algo='sha256', their=''] = (headerSig || '').split('=');
      const ours = computeHmac(algo, rawBuf, APP_SECRET);
      console.log('SigDebug:', { algo, len: rawBuf.length, valid: false },
        '\n  header:', headerSig,
        '\n  ours  :', `${algo}=${ours}`,
        '\n  body  :', rawBuf.toString('utf8').slice(0, 160).replace(/\s+/g, ' ')
      );
    }
    return res.sendStatus(401);
  }

  // dedupe exact retries by hashing the raw body
  if (isDuplicateDelivery(rawBuf)) {
    if (SIG_DEBUG === '1') console.log('🔁 duplicate delivery skipped');
    return res.sendStatus(200);
  }

  res.sendStatus(200); // ack fast

  // handle payload
  let body; try { body = JSON.parse(rawBuf.toString('utf8')); } catch { return; }
  if (!body?.object || !Array.isArray(body.entry)) return;

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      /* ===== comments ===== */
      if (change.field === 'comments' && change.value?.id) {
        const commentId = change.value.id;

        // extra dedupe by comment id (Meta may re-send)
        if (seenCommentIds.has(commentId)) {
          if (SIG_DEBUG === '1') console.log('↩️ already processed comment', commentId);
          continue;
        }
        seenCommentIds.add(commentId);
        pruneSeen();

        // 1) fetch + log details (who commented, text, parent/top-level, media)
        try {
          const { data } = await axios.get(
            `https://graph.facebook.com/v23.0/${commentId}`,
            { params: { fields: 'id,username,text,parent_id,media{id,caption}', access_token: PAGE_ACCESS_TOKEN } }
          );
          console.log('📝 Comment detail:', data);
        } catch (e) {
          console.error('Read comment failed:', apiErr(e));
        }

        // 2) private reply to TOP-LEVEL (parent if present) — prompts them to DM
        try {
          await sendPrivateReplySmart(commentId, AUTO_REPLY_MESSAGE);
          console.log('✉️ Private reply sent for', commentId);
        } catch (e) {
          console.error('Private reply failed:', apiErr(e));
        }
      }

      /* ===== messages (DM) ===== */
      if (change.field === 'messages') {
        const msgs = change.value?.messages || [];
        for (const m of msgs) {
          const fromId = m?.from?.id;  // <-- IGSID needed to DM
          if (!fromId) continue;
          if (IG_BUSINESS_ID && String(fromId) === String(IG_BUSINESS_ID)) continue; // ignore ourselves

          console.log('📨 DM received:', { fromId, text: (m?.text || '').trim() });

          try {
            await sendCarousel(fromId);
            console.log('🧾 Carousel sent to', fromId);
          } catch (e) {
            console.error('Send carousel failed:', apiErr(e));
          }
        }
      }
    }
  }
});

/* ----------------- start ----------------- */
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));

/* ================= helpers ================= */
function computeHmac(algo, buf, secret) {
  try { return crypto.createHmac(algo, secret).update(buf).digest('hex'); }
  catch { return crypto.createHmac('sha256', secret).update(buf).digest('hex'); }
}
function verifySig(headerSig, raw, secret) {
  if (!secret || !headerSig || !raw) return false;
  const [algo, theirHex] = headerSig.split('=');
  if (!algo || !theirHex) return false;
  const ourHex = computeHmac(algo, raw, secret);
  try { return crypto.timingSafeEqual(Buffer.from(theirHex), Buffer.from(ourHex)); }
  catch { return false; }
}

/* -- dedupe (raw body) -- */
const seenDeliveries = new Map(); // hash -> ts
function isDuplicateDelivery(rawBuf) {
  const key = crypto.createHash('sha256').update(rawBuf).digest('hex');
  const now = Date.now();
  if (seenDeliveries.has(key)) return true;
  seenDeliveries.set(key, now);
  // prune old (>10 min)
  for (const [k, t] of seenDeliveries) if (now - t > 10 * 60 * 1000) seenDeliveries.delete(k);
  return false;
}
/* -- extra dedupe per comment id -- */
const seenCommentIds = new Set();
function pruneSeen() {
  // lightweight: clear set if it grows too big
  if (seenCommentIds.size > 2000) seenCommentIds.clear();
}

async function sendPrivateReplySmart(commentId, message) {
  // reply to top-level
  let targetId = commentId;
  const { data } = await axios.get(
    `https://graph.facebook.com/v23.0/${commentId}`,
    { params: { fields: 'id,parent_id', access_token: PAGE_ACCESS_TOKEN } }
  );
  if (data?.parent_id) targetId = data.parent_id;

  const url  = `https://graph.facebook.com/v23.0/${targetId}/private_replies`;
  const body = new URLSearchParams({ message, access_token: PAGE_ACCESS_TOKEN });
  await axios.post(url, body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
}

async function sendCarousel(igsid) {
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
  await axios.post('https://graph.facebook.com/v23.0/me/messages',
    payload, { params: { access_token: PAGE_ACCESS_TOKEN } });
}

function apiErr(err) {
  if (err?.response) return `HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`;
  return String(err?.message || err);
}

function helloHTML(method) {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${method}</title>
  <style>body{font-family:system-ui,Arial;padding:24px}</style></head>
  <body><h1>This is ${method} Request, Hello Webhook!</h1></body></html>`;
}
function privacyHTML() {
  const d = new Date().toISOString().slice(0,10);
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Privacy Policy</title>
  <style>body{font-family:system-ui,Arial;padding:24px;line-height:1.6;max-width:860px;margin:auto}</style></head>
  <body><h1>Privacy Policy</h1>
  <p>Effective date: <strong>${d}</strong></p>
  <p>We use Instagram data you authorize to provide features such as private replies and catalogs.</p>
  <p>We do not sell personal data. You may revoke permissions anytime in Instagram/Facebook settings.</p>
  <p>Contact: contact@example.com</p></body></html>`;
}
