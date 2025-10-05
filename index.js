/* eslint-disable no-console */
require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

/** -------------------------------
 *  Webhook verification (GET)
 *  Configure this same URL in your Meta App: Webhooks -> Instagram -> Callback URL
 *  and set the Verify Token to META_VERIFY_TOKEN.
 *  ------------------------------- */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/** -------------------------------
 *  Webhook receiver (POST)
 *  We ACK quickly, then process entries.
 *  ------------------------------- */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // ACK fast so Meta doesn't retry

  try {
    const entries = Array.isArray(req.body.entry) ? req.body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];

      for (const change of changes) {
        // Instagram comment subscription
        if (change.field === "comments") {
          // Depending on the payload version, these fields can differ slightly:
          const v = change.value || {};
          const commentId = v.id || v.comment_id;
          const commentText = v.text || "";
          const mediaId = v.media_id || v.media || null;

          console.log("Comment event:", { commentId, commentText, mediaId });

          if (!commentId) continue;

          // 👇 Your matching logic goes here. For demo, reply to every comment.
          const replyText = "Thanks for your comment! 🎁 Check your DM.";

          try {
            await sendPrivateReply(commentId, replyText);
            console.log("Private reply sent to comment:", commentId);
          } catch (err) {
            console.error("Failed to send private reply:", err?.response?.data || err.message);
          }
        }

        // You can also listen to 'messages' if you want the DM inbox events
        if (change.field === "messages") {
          console.log("Message event:", JSON.stringify(change.value));
        }
      }
    }
  } catch (e) {
    console.error("Webhook handling error:", e);
  }
});

/** -------------------------------
 *  Sender: PRIVATE REPLY
 *  This uses the Instagram Messaging API (facebook graph), not Basic Display.
 *  Endpoint: /{IG_USER_ID}/messages
 *  Body: recipient.comment_id + message.text
 *  ------------------------------- */
async function sendPrivateReply(commentId, text) {
  const FB_GRAPH = "https://graph.facebook.com/v21.0";
  const url = `${FB_GRAPH}/${process.env.IG_BUSINESS_ID}/messages`;

  const body = {
    recipient: { comment_id: commentId }, // <-- required for Private Replies
    message: { text }
  };

  const params = { access_token: process.env.PAGE_ACCESS_TOKEN };

  const r = await axios.post(url, body, {
    params,
    timeout: 15000,
    validateStatus: () => true
  });

  if (r.status < 200 || r.status >= 300) {
    throw new Error(`DM failed ${r.status}: ${JSON.stringify(r.data)}`);
  }
  return r.data;
}

/** -------------------------------
 *  Health
 *  ------------------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/** -------------------------------
 *  Start
 *  ------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on http://localhost:${PORT}`));
