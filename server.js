/* eslint-disable no-console */
const express = require('express');
const morgan  = require('morgan');
const crypto  = require('crypto');
const axios   = require('axios');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

/* =================== ENV =================== */
const {
  PORT = 3000,
  VERIFY_TOKEN,
  APP_SECRET,
  // Token used to read comment details and post private replies
  PAGE_ACCESS_TOKEN,
  // 🔑 Token used SPECIFICALLY to send DMs (another Page token you mentioned)
  DM_PAGE_ACCESS_TOKEN,
  // Messaging text
  DM_MESSAGE_TEXT = 'Thanks for your comment! Check our catalog: https://example.com',
  AUTO_REPLY_MESSAGE = 'Thanks for the comment! We just messaged you. ✉️',
  SIG_DEBUG = '0',
} = process.env;

if (!DM_PAGE_ACCESS_TOKEN) {
  console.warn('⚠️  DM_PAGE_ACCESS_TOKEN not set — DM calls will fail.');
}

/* =================== Middleware =================== */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.header('Access-Control-Request-Headers') || '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(morgan('tiny'));

/* Keep /webhook raw & non-inflated so signature matches exactly */
const rawParser = express.raw({ type: '*/*', inflate: false, limit: '5mb' });

/* =================== Health/Policy =================== */
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/privacy-policy', (_req, res) => {
  res.type('html').send(`<!doctype html><html><body>
  <h1>Privacy Policy</h1><p>We use Instagram data you authorize to provide automated replies and messages.</p>
  </body></html>`);
});

/* =================== Verify (GET) =================== */
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* =================== Receive (POST) =================== */
app.post('/webhook', rawParser, async (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const sig = (req.get('x-hub-signature-256') || req.get('x-hub-signature') || '').replace(/"/g, '');

    const valid = verifySig(sig, raw, (APP_SECRET || '').trim());
    if (SIG_DEBUG === '1') {
      const algo = sig?.split('=')[0] || 'none';
      console.log('SigDebug:', { algo, len: raw.length, valid },
        '\n body:', raw.toString('utf8').slice(0, 200).replace(/\s+/g, ' '));
    }
    if (!valid) return res.sendStatus(401);
    res.sendStatus(200);

    // Handle payload
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field === 'comments' && change.value?.id) {
          const commentId = change.value.id;

          // 1) Get commenter IGSID
          let igsid = change.value?.from?.id || null;
          if (!igsid) {
            igsid = await fetchCommenterIgsid(commentId);
          }
          console.log('🧑‍💻 Commenter IGSID:', igsid || '(not found)');

          // 2) Try to DM using the separate token
          if (igsid) {
            try {
              await sendDmText(igsid, DM_MESSAGE_TEXT);
              console.log('📩 DM sent to', igsid);
            } catch (e) {
              console.error('DM failed:', errorMsg(e));
            }
          }

          // 3) Always send a private reply to the TOP-LEVEL comment (lands in their inbox)
          try {
            await privateReplyTop(commentId, AUTO_REPLY_MESSAGE);
            console.log('✉️ Private reply sent for', commentId);
          } catch (e) {
            console.error('Private reply failed:', errorMsg(e));
          }
        }

        // If you also subscribed to messages: echo back or send carousel, etc.
        if (change.field === 'messages') {
          const msgs = change.value?.messages || [];
          for (const m of msgs) {
            const fromId = m?.from?.id;
            const text = (m?.text || '').trim();
            console.log('📨 DM event:', { fromId, text });
            if (fromId) {
              try {
                await sendDmText(fromId, 'Got it! Thanks for messaging us 🙌');
              } catch (e) {
                console.error('Reply DM failed:', errorMsg(e));
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    try { res.sendStatus(200); } catch {}
  }
});

/* =================== Start =================== */
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));

/* =================== Helpers =================== */
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

/* Fetch commenter IGSID. Prefer webhook "from.id"; if absent, query the comment. */
async function fetchCommenterIgsid(commentId) {
  const r = await axios.get(`https://graph.facebook.com/v23.0/${commentId}`, {
    params: {
      fields: 'from{id,username}',
      access_token: PAGE_ACCESS_TOKEN
    },
    timeout: 30000,
    validateStatus: () => true
  });
  if (r.status >= 200 && r.status < 300) return r.data?.from?.id || null;
  console.error('fetchCommenterIgsid failed:', errorMsg({ response: r }));
  return null;
}

/* Private reply must go to the TOP-LEVEL comment */
async function privateReplyTop(commentId, message) {
  // Find parent_id (if this is a reply to a comment)
  let targetId = commentId;
  const r = await axios.get(`https://graph.facebook.com/v23.0/${commentId}`, {
    params: { fields: 'id,parent_id', access_token: PAGE_ACCESS_TOKEN },
    timeout: 30000, validateStatus: () => true
  });
  if (r.status >= 200 && r.status < 300 && r.data?.parent_id) targetId = r.data.parent_id;

  const url  = `https://graph.facebook.com/v23.0/${targetId}/private_replies`;
  const body = new URLSearchParams({ message, access_token: PAGE_ACCESS_TOKEN });
  const pr = await axios.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000, validateStatus: () => true
  });
  if (pr.status < 200 || pr.status >= 300) {
    throw new Error(`HTTP ${pr.status} ${pr.statusText} — ${JSON.stringify(pr.data)}`);
  }
}

/* Send a plain DM using the SEPARATE token you provided */
async function sendDmText(igsid, text) {
  const payload = {
    recipient: { id: igsid },
    messaging_type: 'RESPONSE',
    message: { text }
  };
  const r = await axios.post(
    'https://graph.facebook.com/v23.0/me/messages',
    payload,
    {
      params: { access_token: DM_PAGE_ACCESS_TOKEN },
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000, validateStatus: () => true
    }
  );
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`HTTP ${r.status} ${r.statusText} — ${JSON.stringify(r.data)}`);
  }
}

function errorMsg(err) {
  if (err?.response) {
    return `HTTP ${err.response.status} ${err.response.statusText} — ${JSON.stringify(err.response.data)}`;
  }
  return String(err?.message || err);
}
