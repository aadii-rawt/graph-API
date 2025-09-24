const express = require('express');
const morgan = require('morgan');
const crypto = require('crypto');
const axios = require('axios');           // <-- use axios
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

const {
  PORT = 3000,
  VERIFY_TOKEN,
  APP_SECRET,
  PAGE_ACCESS_TOKEN,
  AUTO_REPLY_MESSAGE = 'Thanks for the comment! 🙌',
  IG_BUSINESS_ID,
  IG_USERNAME,
  SIG_DEBUG = '0',
  TEMP_DISABLE_SIG = '0',
} = process.env;

// Open CORS (not required for Meta → server-to-server)
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

const seenCommentIds = new Set();

// Resolve own IG username (so we don't reply to ourselves)
let SELF_USERNAME = IG_USERNAME || null;
(async () => {
  try {
    if (!SELF_USERNAME && IG_BUSINESS_ID && PAGE_ACCESS_TOKEN) {
      const { data } = await axios.get(
        `https://graph.facebook.com/v23.0/${IG_BUSINESS_ID}`,
        { params: { fields: 'username', access_token: PAGE_ACCESS_TOKEN } }
      );
      if (data?.username) {
        SELF_USERNAME = String(data.username);
        console.log('👤 Detected IG username:', SELF_USERNAME);
      }
    }
  } catch (_) {}
})();

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Verify webhook (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.type('html').send(HELLO_HTML('GET'));
});

// Receive webhook (POST) — raw so signature matches
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    if (TEMP_DISABLE_SIG === '1') {
      if (SIG_DEBUG === '1') console.log('⚠️ TEMP_DISABLE_SIG=1 — skipping signature verification');
      res.status(200).send(HELLO_HTML('POST'));
      safeProcessWebhook(req);
      return;
    }

    const sig256 = req.get('x-hub-signature-256');
    const sig1 = req.get('x-hub-signature');
    const headerSig = sig256 || sig1;
    const rawBuf = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');
    const valid = verifyMetaSignature(headerSig, rawBuf, APP_SECRET);

    if (SIG_DEBUG === '1') {
      const sample = rawBuf.toString('utf8').slice(0, 80).replace(/\s+/g, ' ');
      console.log('🔎 SigDebug ->', {
        algo: headerSig ? headerSig.split('=')[0] : 'none',
        rawLen: rawBuf.length,
        valid,
      });
      console.log('🔎 BodySample:', sample);
    }

    if (!APP_SECRET || !valid) {
      console.warn('❌ Invalid or missing signature on webhook POST');
      return res.sendStatus(401);
    }

    res.sendStatus(200);
    await processWebhookBuffer(rawBuf);
  } catch (err) {
    console.error('Webhook handler error:', err);
    try { res.sendStatus(200); } catch {}
  }
});

// Privacy policy
app.get('/privacy-policy', (_req, res) => {
  res.type('html').send(PRIVACY_POLICY_HTML());
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// ===== Helpers =====
function verifyMetaSignature(headerSig, rawBodyBuf, appSecret) {
  if (!appSecret || !headerSig || !rawBodyBuf) return false;
  const parts = headerSig.split('=');
  if (parts.length !== 2) return false;
  const algo = parts[0];          // 'sha256' or 'sha1'
  const theirHex = parts[1];

  let hmacHex;
  try {
    hmacHex = crypto.createHmac(algo, appSecret).update(rawBodyBuf).digest('hex');
  } catch {
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
        if (seenCommentIds.has(commentId)) {
          if (SIG_DEBUG === '1') console.log('↩️ already handled', commentId);
          continue;
        }
        seenCommentIds.add(commentId);

        // avoid replying to ourselves
        let author = change.value.username || null;
        if (!author) {
          try {
            const { data } = await axios.get(
              `https://graph.facebook.com/v23.0/${commentId}`,
              { params: { fields: 'username', access_token: PAGE_ACCESS_TOKEN } }
            );
            author = data?.username || null;
          } catch (_) {}
        }
        if (author && SELF_USERNAME && author.toLowerCase() === SELF_USERNAME.toLowerCase()) {
          if (SIG_DEBUG === '1') console.log('🛑 own comment; skipping reply');
          continue;
        }

        const text = change.value?.text;
        console.log('📝 New comment:', { commentId, author, text });

        // === PUBLIC REPLY ===
        try {
          await sendPublicReply(commentId, AUTO_REPLY_MESSAGE);
          console.log('💬 Public reply posted to', commentId);
        } catch (err) {
          console.error('Public reply failed:', errorMessage(err));
        }

        // If you ALSO want a private reply DM, uncomment:
        // try { await sendPrivateReply(commentId, 'Thanks! I just DMed you details. ✉️'); }
        // catch (err) { console.error('Private reply failed:', errorMessage(err)); }
      }

      if (change.field === 'messages') {
        console.log('📨 DM event:', JSON.stringify(change.value));
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

async function sendPublicReply(commentId, message) {
  // POST /{ig-comment-id}/replies
  const url = `https://graph.facebook.com/v23.0/${commentId}/replies`;
  const body = new URLSearchParams({
    message,
    access_token: PAGE_ACCESS_TOKEN,
  });
  await axios.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function sendPrivateReply(commentId, message) {
  const url = `https://graph.facebook.com/v23.0/${commentId}/private_replies`;
  const body = new URLSearchParams({
    message,
    access_token: PAGE_ACCESS_TOKEN,
  });
  await axios.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

function errorMessage(err) {
  if (err?.response) {
    return `HTTP ${err.response.status} ${err.response.statusText} — ${JSON.stringify(err.response.data)}`;
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
