const Automation = require("../models/Automation");

function cleanKeywords(arr) {
  return Array.from(new Set((arr || []).map(k => String(k).trim().toLowerCase()).filter(Boolean)));
}

exports.createAutomation = async (req, res) => {
  try {
    const ownerId = req.userId || "demo"; // wire your auth later
    const {
      igMediaId, igMediaPermalink, igMediaThumb,
      anyKeyword = false,
      keywords = [],
      messageText = "",
      links = [],
      carousel = [],
      isActive = true,
    } = req.body;

    if (!igMediaId) return res.status(400).json({ error: "igMediaId required" });

    const doc = await Automation.create({
      ownerId, igMediaId, igMediaPermalink, igMediaThumb,
      anyKeyword: Boolean(anyKeyword),
      keywords: cleanKeywords(keywords),
      messageText, links, carousel, isActive
    });

    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};

exports.listAutomations = async (req, res) => {
  try {
    const ownerId = req.userId || "demo";
    const list = await Automation.find({ ownerId }).sort({ createdAt: -1 });
    res.json({ data: list });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};

exports.getAutomation = async (req, res) => {
  try {
    const ownerId = req.userId || "demo";
    const doc = await Automation.findOne({ _id: req.params.id, ownerId });
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ data: doc });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};

exports.updateAutomation = async (req, res) => {
  try {
    const ownerId = req.userId || "demo";
    const b = req.body;
    if (b.keywords) b.keywords = cleanKeywords(b.keywords);
    const doc = await Automation.findOneAndUpdate(
      { _id: req.params.id, ownerId },
      { $set: b },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};

exports.deleteAutomation = async (req, res) => {
  try {
    const ownerId = req.userId || "demo";
    await Automation.deleteOne({ _id: req.params.id, ownerId });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
