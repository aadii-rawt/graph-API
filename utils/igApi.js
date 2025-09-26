// utils/igApi.js
/* eslint-disable no-console */
const axios = require("axios");

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
if (!PAGE_ACCESS_TOKEN) {
  console.warn("[igApi] PAGE_ACCESS_TOKEN is missing in .env");
}

let CACHED_PAGE_ID = process.env.PAGE_ID || null;

/** Resolve and cache the Page ID (if not provided via .env) */
async function getPageId() {
  if (CACHED_PAGE_ID) return CACHED_PAGE_ID;
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN is missing");

  const r = await axios.get("https://graph.facebook.com/v21.0/me", {
    params: { access_token: PAGE_ACCESS_TOKEN },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(
      `Failed to resolve PAGE_ID: ${r.status} ${JSON.stringify(r.data)}`
    );
  }
  CACHED_PAGE_ID = r.data?.id;
  if (!CACHED_PAGE_ID) throw new Error("No Page id in /me response");
  return CACHED_PAGE_ID;
}

/**
 * ✅ Instagram PRIVATE REPLY (one message per comment within 7 days)
 * POST https://graph.facebook.com/v21.0/{commentId}/private_replies
 */
async function sendPrivateReply(commentId, message) {
  if (!commentId) throw new Error("sendPrivateReply: missing commentId");
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN is missing");

  const url = `https://graph.facebook.com/v21.0/${commentId}/private_replies`;
  const r = await axios.post(
    url,
    { message }, // IG expects { message: "text" }
    {
      // You can also use params: { access_token: PAGE_ACCESS_TOKEN }
      headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` },
      timeout: 15000,
      validateStatus: () => true,
    }
  );

  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`Private reply failed ${r.status}: ${JSON.stringify(r.data)}`);
}

/**
 * Optional: plain-text Instagram DM (use AFTER user replies in DM).
 * POST https://graph.facebook.com/v21.0/{PAGE_ID}/messages
 */
async function sendTextDM(igUserId, text) {
  if (!igUserId) throw new Error("sendTextDM: missing igUserId");
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN is missing");

  const PAGE_ID = await getPageId();
  const url = `https://graph.facebook.com/v21.0/${PAGE_ID}/messages`;
  const payload = {
    messaging_product: "instagram",
    recipient: { id: igUserId },
    message: { text },
  };
  const r = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`DM text failed ${r.status}: ${JSON.stringify(r.data)}`);
}

/**
 * Optional: carousel/generic template DM (max 10 cards).
 */
async function sendCarouselDM(igUserId, elements) {
  if (!igUserId) throw new Error("sendCarouselDM: missing igUserId");
  if (!Array.isArray(elements) || !elements.length)
    throw new Error("sendCarouselDM: elements must be a non-empty array");
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN is missing");

  const PAGE_ID = await getPageId();
  const url = `https://graph.facebook.com/v21.0/${PAGE_ID}/messages`;
  const payload = {
    messaging_product: "instagram",
    recipient: { id: igUserId },
    message: {
      attachment: {
        type: "template",
        payload: { template_type: "generic", elements },
      },
    },
  };
  const r = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`DM carousel failed ${r.status}: ${JSON.stringify(r.data)}`);
}

/** Resolve a business media permalink from a business media id (handy for matching) */
async function getBusinessMediaPermalink(mediaId) {
  if (!mediaId) throw new Error("getBusinessMediaPermalink: missing mediaId");
  if (!PAGE_ACCESS_TOKEN) throw new Error("PAGE_ACCESS_TOKEN is missing");

  const url = `https://graph.facebook.com/v21.0/${mediaId}`;
  const r = await axios.get(url, {
    params: { access_token: PAGE_ACCESS_TOKEN, fields: "permalink" },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (r.status >= 200 && r.status < 300) return r.data?.permalink || null;
  throw new Error(
    `getBusinessMediaPermalink failed ${r.status}: ${JSON.stringify(r.data)}`
  );
}

/** Map your automation to Messenger "generic" template elements */
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
  sendPrivateReply,     // <-- use THIS in your controller first
  sendTextDM,           // <-- use after user replies in DM (24h window)
  sendCarouselDM,       // optional
  getBusinessMediaPermalink,
  toGenericElements,
};
