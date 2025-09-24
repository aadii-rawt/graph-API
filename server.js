const express = require('express');
const morgan = require('morgan');
const crypto = require('crypto');
const axios = require('axios');
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
  TEMP_DISABLE_SIG = '0'
} = process.env;

/* ---------- allow all origins (no cors lib) ---------- */
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

/* ---------- Root page (avoid 404 on /) ---------- */
app.get('/', (_req, res) => res.type('html').send(helloHTML('GET')));

/* ---------- (Optional) detect own IG username ---------- */
let SELF_USERNAME = IG_USERNAME || null;
(async () => {
  try {
    if (!SELF_USERNAME && IG_BUSINESS_ID && PAGE_ACCESS_TOKEN) {
      const { data } = await axios.get(`https://graph.facebook.com/v23.0/${IG_BUSINESS_ID}`, {
        params: { fields: 'username', access_token: PAGE_ACCESS_TOKEN }
      });
      if (data?.username) {
        SELF_USERNAME = String(data.username);
        console.log('👤 IG username:', SELF_USERNAME);
      }
    }
  } catch (_) {}
})();

/* ---------- Health ---------- */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ---------- Webhook verification (GET) ---------- */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.type('html').send(helloHTML('GET'));
});

/* ---------- Webhook receiver (POST) ---------- */
/* Use raw body so HMAC signature matches exactly */
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    if (TEMP_DISABLE_SIG === '1') {
      if (SIG_DEBUG === '1') console.log('⚠️ TEMP_DISABLE_SIG=1 — skipping signature verification');
      res.status(200).send(helloHTML('POST'));
      safeProcessWebhook(req);
      return;
    }

    const sig256 = req.get('x-hub-signature-256');
    const sig1 = req.get('x-hub-signature');
    const headerSig = sig256 || sig1;
    const rawBuf = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');

    const valid = verifySig(headerSig, rawBuf, APP_SECRET);
    if (!APP_SECRET || !valid) {
      if (SIG_DEBUG === '1') {
        const sample = rawBuf.toString('utf8').slice(0, 120).replace(/\s+/g, ' ');
        console.log('SigDebug:', { algo: headerSig?.split('=')[0], len: rawBuf.length, valid }, sample);
      }
      return res.sendStatus(401);
    }

    res.sendStatus(200);
    await processPayload(rawBuf);
  } catch (e) {
    console.error('Webhook error:', e);
    try { res.sendStatus(200); } catch {}
  }
});

/* ---------- Privacy ---------- */
app.get('/privacy-policy', (_req, res) => res.type('html').send(privacyHTML()));

/* ---------- Start ---------- */
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));

/* ================= Helpers ================= */

function verifySig(headerSig, raw, secret) {
  if (!secret || !headerSig || !raw) return false;
  const [algo, theirs] = headerSig.split('=');
  if (!algo || !theirs) return false;
  let ours;
  try { ours = crypto.createHmac(algo, secret).update(raw).digest('hex'); }
  catch { ours = crypto.createHmac('sha256', secret).update(raw).digest('hex'); }
  try { return crypto.timingSafeEqual(Buffer.from(theirs), Buffer.from(ours)); }
  catch { return false; }
}

async function processPayload(rawBuf) {
  let body;
  try { body = JSON.parse(rawBuf.toString('utf8')); }
  catch { return; }
  if (!body?.object || !Array.isArray(body.entry)) return;

  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      /* ----- New comment: private reply (top-level), else public reply ----- */
      if (change.field === 'comments' && change.value?.id) {
        const commentId = change.value.id;

        try {
          await sendPrivateReplySmart(commentId, AUTO_REPLY_MESSAGE);
          console.log('✉️ Private reply sent for', commentId);
        } catch (err) {
          console.error('Private reply failed (will fall back to public):', errMessage(err));
          try {
            await sendPublicReply(commentId, AUTO_REPLY_MESSAGE);
            console.log('💬 Public reply posted to', commentId);
          } catch (e2) {
            console.error('Public reply also failed:', errMessage(e2));
          }
        }
      }

      /* ----- Incoming DM: send carousel (requires IGSID) ----- */
      if (change.field === 'messages') {
        const msgs = change.value?.messages || [];
        for (const m of msgs) {
          const fromId = m?.from?.id;                   // <-- IGSID (recipient id for /me/messages)
          const text = (m?.text || '').trim().toLowerCase();

          // ignore our own messages
          if (fromId && IG_BUSINESS_ID && String(fromId) === String(IG_BUSINESS_ID)) continue;

          if (fromId && (text || m?.attachments)) {
            try {
              await sendCarousel(fromId);
              console.log('🧾 Carousel sent to', fromId);
            } catch (err) {
              console.error('Send carousel failed:', errMessage(err));
            }
          }
        }
      }
    }
  }
}

function safeProcessWebhook(req) {
  try {
    const buf = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');
    processPayload(buf);
  } catch (e) {
    console.error('safeProcessWebhook error:', e);
  }
}

/** Private reply to the TOP-LEVEL comment (parent_id when present) */
async function sendPrivateReplySmart(commentId, message) {
  // 1) Find parent_id; private reply must target the top-level comment
  let targetId = commentId;
  const { data } = await axios.get(
    `https://graph.facebook.com/v23.0/${commentId}`,
    { params: { fields: 'id,parent_id', access_token: PAGE_ACCESS_TOKEN } }
  );
  if (data?.parent_id) targetId = data.parent_id;

  // 2) Send private reply
  const url = `https://graph.facebook.com/v23.0/${targetId}/private_replies`;
  const body = new URLSearchParams({ message, access_token: PAGE_ACCESS_TOKEN });
  await axios.post(url, body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
}

/** Public reply (allowed on your own media) */
async function sendPublicReply(commentId, message) {
  const url = `https://graph.facebook.com/v23.0/${commentId}/replies`;
  const body = new URLSearchParams({ message, access_token: PAGE_ACCESS_TOKEN });
  await axios.post(url, body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
}

/** Send a 1-card carousel to an IGSID (from webhook messages[].from.id) */
async function sendCarousel(igsid) {
  const payload = {
    recipient: { id: igsid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title: 'Browse our products',
              subtitle: 'Tap below to view the full catalog',
              image_url: CAROUSEL_IMAGE_URL || CATALOG_URL,
              default_action: { type: 'web_url', url: CATALOG_URL },
              buttons: [{ type: 'web_url', url: CATALOG_URL, title: 'View all products' }]
            }
          ]
        }
      }
    }
  };

  await axios.post(
    'https://graph.facebook.com/v23.0/me/messages',
    payload,
    { params: { access_token: PAGE_ACCESS_TOKEN } }
  );
}

function errMessage(err) {
  if (err?.response) {
    return `HTTP ${err.response.status} ${err.response.statusText} — ${JSON.stringify(err.response.data)}`;
  }
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
