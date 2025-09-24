const express = require('express');
const morgan = require('morgan');
const crypto = require('crypto');
const fetch = require('node-fetch'); // v2
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const AUTO_REPLY_MESSAGE =
  process.env.AUTO_REPLY_MESSAGE || 'Thanks for your comment! 🙌';

// --- allow ALL origins ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.header('Access-Control-Request-Headers') || '*'
  );
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// keep raw body for signature validation
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(morgan('tiny'));

// health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// ========== GET /webhook ==========
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }

  // show simple page if opened in browser
  return res.type('html').send(HELLO_HTML('GET'));
});

// ========== POST /webhook ==========
app.post('/webhook', async (req, res) => {
  const isTest = req.query.test === '1';

  try {
    const sig256 = req.get('x-hub-signature-256');
    const sig1 = req.get('x-hub-signature');
    const headerSig = sig256 || sig1;

    // For Meta → verify signature
    if (!isTest) {
      if (!APP_SECRET || !verifyMetaSignature(headerSig, req.rawBody, APP_SECRET)) {
        console.warn('❌ Invalid or missing signature on webhook POST');
        return res.sendStatus(401);
      }
      res.sendStatus(200); // ack quickly
    } else {
      // test mode: show demo page
      return res.type('html').send(HELLO_HTML('POST'));
    }

    // --- process real webhook payload ---
    const body = req.body;
    if (!body?.object || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field === 'comments' && change.value?.id) {
          const commentId = change.value.id;
          const text = change.value?.text;
          console.log('📝 New comment:', { commentId, text });

          try {
            await sendPrivateReply(commentId, AUTO_REPLY_MESSAGE);
            console.log('📩 Private reply sent');
          } catch (err) {
            console.error('Private reply failed:', await safeText(err));
          }
        }
        if (change.field === 'messages') {
          console.log('💬 DM event:', JSON.stringify(change.value));
        }
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }
});

// ========== Privacy Policy ==========
app.get('/privacy-policy', (_req, res) => {
  res.type('html').send(PRIVACY_POLICY_HTML());
});

// start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// ===== Helpers =====
function verifyMetaSignature(headerSig, rawBody, appSecret) {
  if (!appSecret || !headerSig || !rawBody) return false;
  const [algo, theirHex] = headerSig.split('=');
  if (!algo || !theirHex) return false;
  const hmac = crypto.createHmac(algo, appSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(theirHex), Buffer.from(hmac));
  } catch {
    return false;
  }
}

async function sendPrivateReply(commentId, message) {
  const url = `https://graph.facebook.com/v23.0/${commentId}/private_replies`;
  const params = new URLSearchParams({
    message,
    access_token: PAGE_ACCESS_TOKEN,
  });
  const r = await fetch(url, { method: 'POST', body: params });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} — ${await r.text()}`);
}

async function safeText(err) {
  try {
    return err?.stack?.toString() || String(err);
  } catch {
    return 'Unknown error';
  }
}

function HELLO_HTML(method) {
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Webhook ${method}</title>
<style>body{font-family:system-ui,Arial;padding:24px}</style></head>
<body><h1>This is ${method} Request, Hello Webhook!</h1></body></html>`;
}

function PRIVACY_POLICY_HTML() {
  const today = new Date().toISOString().slice(0, 10);
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Privacy Policy</title>
  <style>body{font-family:system-ui,Arial;padding:24px;line-height:1.6}</style></head>
  <body><h1>Privacy Policy</h1>
  <p>Effective date: <strong>${today}</strong></p>
  <p>We collect Instagram data (comments, messages, media metadata) you authorize.</p>
  <p>We use it to send automated replies and provide services. We do not sell data.</p>
  <p>You may revoke permissions anytime from Instagram/Facebook settings.</p>
  <p>Contact: contact@example.com</p></body></html>`;
}
