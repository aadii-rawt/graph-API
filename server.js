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
  process.env.AUTO_REPLY_MESSAGE || 'Thanks for your comment! 😊';

// ---- allow ALL origins (no cors package) ----
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // everyone
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  // echo requested headers or allow any
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.header('Access-Control-Request-Headers') || '*'
  );
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// keep raw body for Meta signature verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(morgan('tiny'));

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Webhook verify (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  console.warn('❌ Webhook verify failed');
  return res.sendStatus(403);
});

// --- Webhook receive (POST)
app.post('/webhook', async (req, res) => {
  try {
    // verify x-hub-signature-256
    if (APP_SECRET) {
      const headerSig = req.get('x-hub-signature-256');
      if (!isValidSignature(headerSig, req.rawBody, APP_SECRET)) {
        console.warn('❌ Invalid signature');
        return res.sendStatus(401);
      }
    }

    // ack fast
    res.sendStatus(200);

    const body = req.body;
    if (!body?.object || !Array.isArray(body.entry)) return;

    body.entry.forEach((entry) => {
      (entry.changes || []).forEach(async (change) => {
        if (change.field === 'comments' && change.value?.id) {
          const commentId = change.value.id;
          const text = change.value?.text;
          console.log('📝 New comment:', { commentId, text });

          try {
            await sendPrivateReply(commentId, AUTO_REPLY_MESSAGE);
            console.log('📩 Private reply sent for comment', commentId);
          } catch (err) {
            console.error('Private reply failed:', await safeText(err));
          }
        }
        if (change.field === 'messages') {
          console.log('💬 DM event:', JSON.stringify(change.value));
        }
      });
    });
  } catch (err) {
    console.error('Webhook handler error:', err);
  }
});

// --- Privacy Policy
app.get('/privacy-policy', (_req, res) => {
  res.type('html').send(PRIVACY_POLICY_HTML());
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// helpers
function isValidSignature(headerSig, rawBody, appSecret) {
  if (!headerSig || !headerSig.startsWith('sha256=')) return false;
  const their = headerSig.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(their), Buffer.from(expected));
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
  try { return err?.stack?.toString() || String(err); } catch { return 'Unknown error'; }
}

function PRIVACY_POLICY_HTML() {
  const today = new Date().toISOString().slice(0,10);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Privacy Policy</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;padding:24px;max-width:860px;margin:auto;color:#111}
  h1{font-size:28px;margin-bottom:8px}h2{margin-top:24px;font-size:20px}.muted{color:#555}a{color:#2563eb;text-decoration:none}code{background:#f5f5f5;padding:2px 6px;border-radius:4px}</style></head>
  <body><h1>Privacy Policy</h1><p class="muted">Effective date: <strong>${today}</strong></p>
  <p>We operate this Service and its Instagram integration.</p>
  <h2>Information We Collect</h2><ul>
  <li>Instagram data via Meta APIs (account ID, username, media metadata, comments, messages where authorized).</li>
  <li>Technical data (IP, user agent, logs) for security and debugging.</li></ul>
  <h2>How We Use Information</h2><ul>
  <li>Provide features like comment notifications and one-time private replies.</li>
  <li>Operate, secure, and improve the Service; comply with legal obligations.</li></ul>
  <h2>Rights & Contact</h2>
  <p>You may request access, correction, or deletion. Contact: <a href="mailto:contact@example.com">contact@example.com</a>.</p>
  <p class="muted">Instagram/Meta are third-party services with their own policies.</p></body></html>`;
}
