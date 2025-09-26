// utils/igApi.js
const axios = require("axios");

const PAGE_ID = process.env.PAGE_ID;                 // FB Page linked to IG
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// --- Send a plain text DM ---
async function sendTextDM(igUserId, text) {
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

// --- Send a carousel (generic template) ---
async function sendCarouselDM(igUserId, elements /* array */) {
  const url = `https://graph.facebook.com/v21.0/${PAGE_ID}/messages`;
  const payload = {
    messaging_product: "instagram",
    recipient: { id: igUserId },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements,                     // max 10 cards
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

// --- Map your automation to Messenger "generic template" elements ---
function toGenericElements(automation) {
  if (!automation.carousel?.length && !automation.links?.length) return null;

  // Prefer explicit carousel items; otherwise convert link pills into cards
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

module.exports = { sendTextDM, sendCarouselDM, toGenericElements };
