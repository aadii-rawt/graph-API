/* controllers/webhook.controller.js */
const Automation = require("../models/Automation");
const SendLog = require("../models/SendLog"); // keep if you want idempotency; else remove its usages
const { sendPrivateReply, getBusinessMediaPermalink } = require("../utils/igApi");

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// GET /webhook (verification handshake from Meta)
exports.verify = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
};

// POST /webhook (Instagram events)
exports.receive = async (req, res) => {
  // Ack immediately
  res.sendStatus(200);

  try {
    console.log("=== WEBHOOK BODY START ===");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=== WEBHOOK BODY END ===");

    if (req.body.object !== "instagram") return;

    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "comments") continue;

        const v = change.value || {};

        // ✅ Correct extraction for the payload shape you logged
        const mediaId = v.media?.id || v.media_id || null; // prefer value.media.id
        const commentId = v.id || v.comment_id || null;    // prefer value.id
        const commentText = (v.text || v.message || "").trim();
        const fromId = v.from?.id || null;
        const fromUsername = v.from?.username || null;

        console.log(">> COMMENT RECEIVED", {
          mediaId,
          commentId,
          fromId,
          fromUsername,
          text: commentText,
        });

        if (!mediaId || !commentId) {
          console.warn("Missing mediaId or commentId; cannot reply.");
          continue;
        }

        // 1) Try to find automations by business media id
        let autos = await Automation.find({ igMediaId: mediaId, isActive: true });

        // 2) Fallback: resolve permalink from business media id, then match by permalink
        if (!autos.length) {
          try {
            const permalink = await getBusinessMediaPermalink(mediaId);
            console.log("Resolved permalink:", permalink);
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
          continue;
        }

        for (const a of autos) {
          const lowered = commentText.toLowerCase();
          const keywordMatched =
            a.anyKeyword ||
            (Array.isArray(a.keywords) &&
              a.keywords.length > 0 &&
              a.keywords.some((k) => lowered.includes(String(k).toLowerCase())));
          const matchedKeyword =
            Array.isArray(a.keywords) &&
            a.keywords.find((k) => lowered.includes(String(k).toLowerCase())) || null;

          console.log("Automation", a._id.toString(), {
            anyKeyword: a.anyKeyword,
            keywords: a.keywords,
            keywordMatched,
            matchedKeyword,
          });

          if (!keywordMatched) {
            console.log("Keywords did not match. Not replying for this automation.");
            continue;
          }

          // Optional: idempotency (skip if already sent to this user for this automation)
          if (fromId) {
            const already = await SendLog.findOne({
              automationId: a._id,
              commenterIgUserId: fromId,
            });
            if (already) {
              console.log("Already replied to this user for this automation. Skipping.");
              continue;
            }
          }

          try {
            // FIRST message: Private Reply to the comment (allowed once within 7 days)
            const textToSend =
              a.messageText?.trim() ||
              process.env.AUTO_REPLY_MESSAGE ||
              "Thanks for your comment!";
            console.log("Sending PRIVATE REPLY:", { commentId, textToSend });
            await sendPrivateReply(commentId, textToSend);
            console.log("Private reply sent successfully.");

            // mark as sent if you keep SendLog (remove if you don't want DB writes)
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
