const Automation = require("../models/Automation");
const SendLog = require("../models/SendLog");
const { sendTextDM, sendCarouselDM, toGenericElements } = require("../utils/igApi");

const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;

exports.verify = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
};

exports.receive = async (req, res) => {
  res.sendStatus(200); // ack immediately

  try {
    if (req.body.object !== "instagram") return;

    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "comments") continue;

        const v = change.value || {};
        const mediaId = v.media_id;
        const commentText = (v.text || "").toLowerCase().trim();
        const commenterIgUserId = v.from?.id;
        if (!mediaId || !commenterIgUserId) continue;

        const autos = await Automation.find({ igMediaId: mediaId, isActive: true });

        for (const a of autos) {
          const match =
            a.anyKeyword || (a.keywords.length && a.keywords.some((k) => commentText.includes(k)));
          if (!match) continue;

          const exists = await SendLog.findOne({ automationId: a._id, commenterIgUserId });
          if (exists) continue;

          try {
            const elements = toGenericElements(a);
            if (elements?.length) {
              await sendCarouselDM(commenterIgUserId, elements);
              if (a.messageText) await sendTextDM(commenterIgUserId, a.messageText);
            } else {
              await sendTextDM(commenterIgUserId, a.messageText || "Thanks for your comment!");
            }

            await SendLog.create({
              automationId: a._id,
              commenterIgUserId,
              igCommentId: v.comment_id,
            });
          } catch (err) {
            console.error("DM send failed:", err?.response?.data || err.message || err);
          }
        }
      }
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
};
