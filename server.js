const express = require('express');
const morgan = require('morgan');
const crypto = require('crypto');
const fetch = require('node-fetch'); // v2
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // friendly with Render/NGINX/CDN

const {
  PORT = 3000,
  VERIFY_TOKEN,
  APP_SECRET,
  PAGE_ACCESS_TOKEN,
  AUTO_REPLY_MESSAGE = 'Thanks for your comment! 🙌',
  SIG_DEBUG = '0',
  TEMP_DISABLE_SIG = '0',
} = process.env;

// ---- allow everyone (no cors lib) ----
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.header('Access-Control-Request-Headers') || '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Regular JSON only for non-webhook routes
app.use('/health', express.json());
app.use('/privacy-policy', express.json());
app.use(morgan('tiny'));

// -------- health --------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ======== GET /webhook (verification + friendly page) ========
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  // No verify params → show page like your screenshot
  return res.type('html').send(HELLO_HTML('GET'));
});

// ======== POST /webhook (use raw body for correct HMAC) ========
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    // Temporary bypass if you only want to see that Render receives the POST
    if (TEMP_DISABLE_SIG === '1') {
      if (SIG_DEBUG === '1') console.log('⚠️ TEMP_DISABLE_SIG=1 — skipping signature verification');
      res.status(200).send(HELLO_HTML('POST'));
      safeProcessWebhook(req); // still print/process payload
      return;
    }

    // Meta sends one of these:
    const sig256 = req.get('x-hub-signature-256');
    const sig1 = req.get('x-hub-signature');
    const headerSig = sig256 || sig1;

    const rawBuf = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');
    const contentType = (req.headers['content-type'] || '').toLowerCase();

    const valid = verifyMetaSignature(headerSig, rawBuf, APP_SECRET);

    if (SIG_DEBUG === '1') {
      const sample = rawBuf.toString('utf8').slice(0, 80).replace(/\s+/g, ' ');
      console.log('🔎 SigDebug ->',
        { algo: headerSig ? headerSig.split('=')[0] : 'none',
          contentType, rawLen: rawBuf.length, valid });
      console.log('🔎 BodySample:', sample);
    }

    if (!APP_SECRET || !valid) {
      console.warn('❌ Invalid or missing signature on webhook POST');
      return res.sendStatus(401); // Meta will retry; flip TEMP_DISABLE_SIG=1 to bypass
    }

    // Ack quickly so Meta stops waiting
    res.sendStatus(200);

    // Process after ack
    await processWebhookBuffer(rawBuf);
  } catch (err) {
    console.error('Webhook handler error:', err);
    try { res.sendStatus(200); } catch {}
  }
});

// -------- Privacy Policy --------
app.get('/privacy-policy', (_req, res) => {
  res.type('html').send(PRIVACY_POLICY_HTML());
});

// -------- Start --------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// ================= Helpers =================
function verifyMetaSignature(headerSig, rawBodyBuf, appSecret) {
  if (!appSecret || !headerSig || !rawBodyBuf) return false;
  const parts = headerSig.split('=');
  if (parts.length !== 2) return false;
  const algo = parts[0];          // "sha256" or "sha1"
  const theirHex = parts[1];

  let hmacHex;
  try {
    hmacHex = crypto.createHmac(algo, appSecret).update(rawBodyBuf).digest('hex');
  } catch {
    // fallback to sha256 if something odd arrives
    hmacHex = crypto.createHmac('sha256', appSecret).update(rawBodyBuf).digest('hex');
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(theirHex), Buffer.from(hmacHex));
  } catch {
    return false;
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
      if (change.field === 'comments' && change.value?.id) {
        const commentId = change.value.id;
        const text = change.value?.text;
        console.log('📝 New comment:', { commentId, text });

        try {
          await sendPrivateReply(commentId, process.env.AUTO_REPLY_MESSAGE || 'Thanks for your comment! 🙌');
          console.log('📩 Private reply sent for comment', commentId);
        } catch (err) {
          console.error('Private reply failed:', await safeText(err));
        }
      }
      if (change.field === 'messages') {
        console.log('💬 DM event:', JSON.stringify(change.value));
      }
    }
  }
}

function safeProcessWebhook(req) {
  try {
    const buf = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');
    processWebhookBuffer(buf);
  } catch (e) {
    console.error('safeProcessWebhook error:', e);
  }
}

async function sendPrivateReply(commentId, message) {
  const url = `https://graph.facebook.com/v23.0/${commentId}/private_replies`;
  const params = new URLSearchParams({ message, access_token: PAGE_ACCESS_TOKEN });
  const r = await fetch(url, { method: 'POST', body: params });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} — ${await r.text()}`);
}

async function safeText(err) {
  try { return err?.stack?.toString() || String(err); } catch { return 'Unknown error'; }
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
