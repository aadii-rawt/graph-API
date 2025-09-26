// utils/igApi.js
/* eslint-disable no-console */
const axios = require("axios");

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
let CACHED_PAGE_ID = process.env.PAGE_ID || null;

/**
 * Resolve the Page ID once (if not provided via .env).
 * Uses the Page Access Token to call /me (which returns the Page profile).
 */
async function getPageId() {
  if (CACHED_PAGE_ID) return CACHED_PAGE_ID;
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN is missing");

  const r = await axios.get("https://graph.facebook.com/v21.0/me", {
    params: { access_token: PAGE_ACCESS_TOKEN },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`Failed to resolve PAGE_ID: ${r.status} ${JSON.stringify(r.data)}`);
  }
  CACHED_PAGE_ID = r.data?.id;
  if (!CACHED_PAGE_ID) throw new Error("Could not read Page id from /me response");
  return CACHED_PAGE_ID;
}

/**
 * Send a Private Reply to a specific comment.
 * Allowed once per comment within 7 days.
 * @param {string} commentId
 * @param {string} message
 */
async function sendPrivateReply(commentId, message) {
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN is missing");
  const url = `https://graph.facebook.com/v21.0/${commentId}/private_replies`;
  const r = await axios.post(
    url,
    { message },
    {
      params: { access_token: PAGE_ACCESS_TOKEN },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`Private reply failed ${r.status}: ${JSON.stringify(r.data)}`);
}

/**
 * Send a plain text Instagram DM (requires that you’re within policy window).
 * @param {string} igUserId PSID from webhook/message context
 * @param {string} text
 */
async function sendTextDM(igUserId, text) {
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN is missing");
  const PAGE_ID = await getPageId();
  const url = `https://graph.facebook.com/v21.0/${PAGE_ID}/messages`;
  const payload = {
    messaging_product: "instagram",
    recipient: { id: igUserId },
    message: { text },
  };
  const r = await axios.post(url, payload, {
    params: { access_token: PAGE_ACCESS_TOKEN },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`DM text failed ${r.status}: ${JSON.stringify(r.data)}`);
}

/**
 * Send a carousel (Generic Template) DM (max 10 cards).
 * @param {string} igUserId
 * @param {Array<object>} elements Messenger "generic" elements
 */
async function sendCarouselDM(igUserId, elements) {
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN is missing");
  const PAGE_ID = await getPageId();
  const url = `https://graph.facebook.com/v21.0/${PAGE_ID}/messages`;
  const payload = {
    messaging_product: "instagram",
    recipient: { id: igUserId },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements, // up to 10
        },
      },
    },
  };
  const r = await axios.post(url, payload, {
    params: { access_token: PAGE_ACCESS_TOKEN },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`DM carousel failed ${r.status}: ${JSON.stringify(r.data)}`);
}

/**
 * Resolve a business media permalink from a business media id.
 * Useful to bridge Basic Display IDs vs Business webhook IDs.
 * @param {string} mediaId
 * @returns {Promise<string|null>}
 */
async function getBusinessMediaPermalink(mediaId) {
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN is missing");
  const url = `https://graph.facebook.com/v21.0/${mediaId}`;
  const r = await axios.get(url, {
    params: { access_token: PAGE_ACCESS_TOKEN, fields: "permalink" },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (r.status >= 200 && r.status < 300) return r.data?.permalink || null;
  throw new Error(`getBusinessMediaPermalink failed ${r.status}: ${JSON.stringify(r.data)}`);
}

/**
 * Map your Automation doc to Messenger "generic" template elements
 * (used for carousel DMs).
 * - If explicit carousel items exist, use them.
 * - Else convert `links` into simple cards.
 */
function toGenericElements(automation) {
  if (!automation?.carousel?.length && !automation?.links?.length) return null;

  const base = automation.carousel?.length
    ? automation.carousel
    : automation.links.map((l) => ({
        title: l.title,
        subtitle: automation.messageText || "",
        imageUrl: automation.igMediaThumb || undefined,
        ctaTitle: "Open Link",
        ctaUrl: l.url,
      }));

  return base.slice(0, 10).map((item) => ({
    title: item.title?.slice(0, 80) || "Link",
    subtitle: item.subtitle?.slice(0, 80) || "",
    image_url: item.imageUrl,
    buttons: item.ctaUrl
      ? [{ type: "web_url", url: item.ctaUrl, title: item.ctaTitle || "Open" }]
      : undefined,
  }));
}

module.exports = {
  getPageId,
  sendPrivateReply,
  sendTextDM,
  sendCarouselDM,
  getBusinessMediaPermalink,
  toGenericElements,
};
