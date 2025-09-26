// controllers/webhook.controller.js
const Automation = require("../models/Automation");     // keep automations DB
const SendLog = require("../models/SendLog");           // keep idempotency, or remove if you don't want it
const {
  sendPrivateReply,
  getBusinessMediaPermalink,
  // sendTextDM, sendCarouselDM, toGenericElements // optional if you want later
} = require("../utils/igApi");

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// GET /webhook (verification handshake)
exports.verify = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
};

// POST /webhook (events)
exports.receive = async (req, res) => {
  // Acknowledge right away
  res.sendStatus(200);

  try {
    // Log the raw body so you can see *everything*
    console.log("=== WEBHOOK BODY START ===");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=== WEBHOOK BODY END ===");

    if (req.body.object !== "instagram") return;

    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "comments") continue;

        const v = change.value || {};
        const mediaId = v.media_id;
        const commentId = v.comment_id;
        const text = (v.text || "").trim();
        const fromId = v.from?.id;
        const fromUsername = v.from?.username;

        // Basic log for each comment (no DB)
        console.log(">> COMMENT RECEIVED", {
          mediaId,
          commentId,
          fromId,
          fromUsername,
          text
        });

        if (!mediaId || !commentId) continue;

        // 1) Try to find automations by business media id
        let autos = await Automation.find({ igMediaId: mediaId, isActive: true });

        // 2) Fallback: resolve permalink from business media id, match by permalink
        if (!autos.length) {
          try {
            const permalink = await getBusinessMediaPermalink(mediaId);
            console.log("Resolved permalink for media:", permalink);
            if (permalink) {
              autos = await Automation.find({ igMediaPermalink: permalink, isActive: true });
            }
          } catch (e) {
            console.warn("Permalink resolution failed:", e?.message || e);
          }
        }

        console.log(`Automations matched for this media: ${autos.length}`);

        if (!autos.length) {
          console.log("No automation for this media. Not replying.");
          continue; // just logging, no reply
        }

        // Process each matched automation (or pick first if you prefer)
        for (const a of autos) {
          const lowered = text.toLowerCase();
          const keywordMatched =
            a.anyKeyword || (a.keywords?.length && a.keywords.some(k => lowered.includes(String(k).toLowerCase())));
          const matchedKeyword = a.keywords?.find(k => lowered.includes(String(k).toLowerCase())) || null;

          console.log("Automation", a._id.toString(), {
            anyKeyword: a.anyKeyword,
            keywords: a.keywords,
            keywordMatched,
            matchedKeyword
          });

          if (!keywordMatched) {
            console.log("Keywords did not match. Not replying for this automation.");
            continue;
          }

          // (Optional) Idempotency: avoid double replies to same user for same automation
          if (fromId) {
            const already = await SendLog.findOne({ automationId: a._id, commenterIgUserId: fromId });
            if (already) {
              console.log("Already replied to this user for this automation. Skipping.");
              continue;
            }
          }

          try {
            const textToSend = a.messageText?.trim() || process.env.AUTO_REPLY_MESSAGE || "Thanks for your comment!";
            console.log("Sending PRIVATE REPLY to comment:", { commentId, textToSend });
            await sendPrivateReply(commentId, textToSend);
            console.log("Private reply sent successfully.");

            // Mark as sent only if you're keeping SendLog (optional)
            if (fromId) {
              await SendLog.create({
                automationId: a._id,
                commenterIgUserId: fromId,
                igCommentId: commentId,
              });
            }
          } catch (err) {
            console.error("Private reply failed:", err?.response?.data || err.message || err);
          }
        }
      }
    }
  } catch (e) {
    console.error("Webhook processing error:", e);
  }
};
