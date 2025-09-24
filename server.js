/* eslint-disable no-console */
const express = require('express');
const morgan  = require('morgan');
const crypto  = require('crypto');
const axios   = require('axios');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

/* =================== HARD-CODED IG (Basic Display) TOKEN =================== */
const IG_URL_ACCESS_TOKEN =
  'IGAAVVFmqvs4JBZAE5SWVlOZAC10QWVHYlZAyNTNNc3dOS3VkcUxGMUFCdHpMQ2hOTF9mWnB5UWZAFT0FhZAUlBZA3FxRWc2U0U4Tl81VDZAudEdQelhBcUVIcUNoSGgzdzh6ZATJqaVRPSnpxTnBFQUxyNjFGM0NINnNqeW9zbHAxS0FuQQZDZD';

/* =================== ENV (Graph API / messaging) =================== */
const {
  PORT = 3000,
  VERIFY_TOKEN,
  APP_SECRET,
  PAGE_ACCESS_TOKEN,          // read comments + private replies
  DM_PAGE_ACCESS_TOKEN,       // default token to send DMs
  DM_MESSAGE_TEXT = 'Thanks for your comment! Check our catalog: https://example.com',
  AUTO_REPLY_MESSAGE = 'Thanks for the comment! We just messaged you. ✉️',
  SIG_DEBUG = '1',
  TEMP_DISABLE_SIG = '0',
} = process.env;

/* =================== Middleware =================== */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.header('Access-Control-Request-Headers') || '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(morgan('tiny'));
app.use(express.json()); // for POST /send-dm

/* RAW parser only for the webhook route */
const rawParser = express.raw({ type: '*/*', inflate: false, limit: '5mb' });

/* =================== Health + Privacy =================== */
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/privacy-policy', (_req, res) => {
  res.type('html').send(`<!doctype html><html><body>
  <h1>Privacy Policy</h1>
  <p>We use Instagram data you authorize to provide automated replies and messages.</p>
  </body></html>`);
});

/* =================== DEBUG routes using IGA token =================== */
app.get('/debug/basic-user', async (_req, res) => {
  try {
    const r = await axios.get('https://graph.instagram.com/v21.0/me', {
      params: { fields: 'id,username,account_type,media_count', access_token: IG_URL_ACCESS_TOKEN }
    });
    res.status(r.status).json(r.data);
  } catch (e) {
    res.status(e?.response?.status || 500).json(e?.response?.data || { error: String(e) });
  }
});
app.get('/debug/basic-media', async (_req, res) => {
  try {
    const r = await axios.get('https://graph.instagram.com/v21.0/me/media', {
      params: {
        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp',
        access_token: IG_URL_ACCESS_TOKEN, limit: 25
      }
    });
    res.status(r.status).json(r.data);
  } catch (e) {
    res.status(e?.response?.status || 500).json(e?.response?.data || { error: String(e) });
  }
});

/* =================== QUICK TOKEN CHECK (Page token?) =================== */
app.get('/debug/whoami', async (req, res) => {
  const token = req.query.token || DM_PAGE_ACCESS_TOKEN;
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const r = await axios.get('https://graph.facebook.com/v23.0/me', { params: { access_token: token } });
    res.json({ ok: true, me: r.data });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ ok: false, error: e?.response?.data || String(e) });
  }
});

/* =================== Webhook verify (GET) =================== */
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* =================== Webhook receive (POST) =================== */
app.post('/webhook', rawParser, async (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const sigHeader = (req.get('x-hub-signature-256') || req.get('x-hub-signature') || '').replace(/"/g, '');

    const { valid, ours256, ours1 } = verifyWithDebug(sigHeader, raw, (APP_SECRET || '').trim());
    if (SIG_DEBUG === '1') {
      console.log('SigDebug:', {
        header: sigHeader,
        ours256: `sha256=${ours256}`,
        ours1:   `sha1=${ours1}`,
        len: raw.length,
        valid
      }, '\n  body:', raw.toString('utf8').slice(0, 220).replace(/\s+/g, ' '));
    }

    if (TEMP_DISABLE_SIG !== '1' && !valid) return res.sendStatus(401);
    if (TEMP_DISABLE_SIG === '1') console.log('⚠️ TEMP_DISABLE_SIG=1 — skipping signature verification');

    res.sendStatus(200); // ACK first

    let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!Array.isArray(payload.entry)) return;

    for (const entry of payload.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field === 'comments' && change.value?.id) {
          const commentId = change.value.id;

          // 1) commenter IGSID
          let igsid = change.value?.from?.id || null;
          if (!igsid) igsid = await fetchCommenterIgsid(commentId);

          console.log('🧑‍💻 Commenter IGSID:', igsid || '(not found)');

          // 2) DM (requires Page token)
          if (igsid && DM_PAGE_ACCESS_TOKEN) {
            try {
              await sendDmText(igsid, DM_MESSAGE_TEXT, DM_PAGE_ACCESS_TOKEN);
              console.log('📩 DM sent to', igsid);
            } catch (e) {
              console.error('DM failed:', errorMsg(e));
            }
          }

          // 3) Private reply to TOP-LEVEL comment
          try {
            await privateReplyTop(commentId, AUTO_REPLY_MESSAGE, PAGE_ACCESS_TOKEN);
            console.log('✉️ Private reply sent for', commentId);
          } catch (e) {
            console.error('Private reply failed:', errorMsg(e));
          }
        }

        if (change.field === 'messages') {
          const msgs = change.value?.messages || [];
          for (const m of msgs) {
            const fromId = m?.from?.id;
            const text   = (m?.text || '').trim();
            console.log('📨 DM event:', { fromId, text });
            if (fromId && DM_PAGE_ACCESS_TOKEN) {
              try { await sendDmText(fromId, 'Got it! 🙌', DM_PAGE_ACCESS_TOKEN); }
              catch (e) { console.error('Reply DM failed:', errorMsg(e)); }
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

/* =================== NEW: manual “send DM” endpoints =================== */

/** GET /send-dm?igsid=...&token=...&text=... 
 *  - igsid: Instagram Scoped ID (e.g. 663105936766237)
 *  - token: Page access token (if omitted, uses DM_PAGE_ACCESS_TOKEN)
 *  - text : message text (optional; defaults to DM_MESSAGE_TEXT or sample)
 */
app.get('/send-dm', async (req, res) => {
  const igsid = req.query.igsid;
  const token = req.query.token || DM_PAGE_ACCESS_TOKEN;
  const text  = req.query.text || DM_MESSAGE_TEXT || 'Hello from /send-dm 👋';

  if (!igsid) return res.status(400).json({ ok: false, error: 'igsid required' });
  if (!token) return res.status(400).json({ ok: false, error: 'token required (Page access token)' });

  try {
    const out = await sendDmText(igsid, text, token);
    return res.json({ ok: true, sent_to: igsid, text, result: out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: errorMsg(e) });
  }
});

/** POST /send-dm
 *  JSON: { "igsid": "...", "token": "...", "text": "..." }
 */
app.post('/send-dm', async (req, res) => {
  const igsid = req.body.igsid;
  const token = req.body.token || DM_PAGE_ACCESS_TOKEN;
  const text  = req.body.text || DM_MESSAGE_TEXT || 'Hello from /send-dm 👋';

  if (!igsid) return res.status(400).json({ ok: false, error: 'igsid required' });
  if (!token) return res.status(400).json({ ok: false, error: 'token required (Page access token)' });

  try {
    const out = await sendDmText(igsid, text, token);
    return res.json({ ok: true, sent_to: igsid, text, result: out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: errorMsg(e) });
  }
});

/* =================== Start =================== */
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));

/* =================== Helpers =================== */
function verifyWithDebug(header, raw, secret) {
  if (!header || !secret || !raw) return { valid: false, ours256: '', ours1: '' };
  const [algo, theirs] = String(header).split('=');
  const ours256 = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const ours1   = crypto.createHmac('sha1',   secret).update(raw).digest('hex');
  let valid = false;
  try {
    if (algo === 'sha256') valid = crypto.timingSafeEqual(Buffer.from(theirs), Buffer.from(ours256));
    else if (algo === 'sha1') valid = crypto.timingSafeEqual(Buffer.from(theirs), Buffer.from(ours1));
  } catch { valid = false; }
  return { valid, ours256, ours1 };
}

async function fetchCommenterIgsid(commentId) {
  const r = await axios.get(`https://graph.facebook.com/v23.0/${commentId}`, {
    params: { fields: 'from{id,username}', access_token: PAGE_ACCESS_TOKEN },
    timeout: 30000, validateStatus: () => true
  });
  if (r.status >= 200 && r.status < 300) return r.data?.from?.id || null;
  console.error('fetchCommenterIgsid failed:', errorMsg({ response: r }));
  return null;
}

async function privateReplyTop(commentId, message, pageToken) {
  let targetId = commentId;
  const r = await axios.get(`https://graph.facebook.com/v23.0/${commentId}`, {
    params: { fields: 'id,parent_id', access_token: pageToken },
    timeout: 30000, validateStatus: () => true
  });
  if (r.status >= 200 && r.status < 300 && r.data?.parent_id) targetId = r.data.parent_id;

  const url  = `https://graph.facebook.com/v23.0/${targetId}/private_replies`;
  const body = new URLSearchParams({ message, access_token: pageToken });
  const pr = await axios.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000, validateStatus: () => true
  });
  if (pr.status < 200 || r.status >= 300) {
    throw new Error(`HTTP ${pr.status} ${pr.statusText} — ${JSON.stringify(pr.data)}`);
  }
}

/* returns axios response.data so caller can include it in JSON */
async function sendDmText(igsid, text, pageToken) {
  const payload = { recipient: { id: igsid }, messaging_type: 'RESPONSE', message: { text } };
  const r = await axios.post('https://graph.facebook.com/v23.0/me/messages', payload, {
    params: { access_token: pageToken },
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000, validateStatus: () => true
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`HTTP ${r.status} ${r.statusText} — ${JSON.stringify(r.data)}`);
  }
  return r.data;
}

function errorMsg(err) {
  if (err?.response) return `HTTP ${err.response.status} ${err.response.statusText} — ${JSON.stringify(err.response.data)}`;
  return String(err?.message || err);
}
