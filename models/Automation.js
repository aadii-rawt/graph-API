const mongoose = require("mongoose");

/**
 * One automation per IG media (post/reel).
 * You can have multiple per media if you want; here we keep 1 for simplicity.
 */
const linkSchema = new mongoose.Schema({
  title: { type: String, trim: true, required: true },
  url:   { type: String, trim: true, required: true },
}, { _id: false });

const carouselItemSchema = new mongoose.Schema({
  title: String,               // optional: title on the bubble
  subtitle: String,            // optional
  imageUrl: String,            // image to show
  ctaTitle: String,            // button title
  ctaUrl: String,              // button url
}, { _id: false });

const automationSchema = new mongoose.Schema({
  ownerId: { type: String, required: true },        // your app's user id (multi-tenant)
  igMediaId: { type: String, required: true },      // the IG post/reel id
  igMediaPermalink: String,
  igMediaThumb: String,
  anyKeyword: { type: Boolean, default: false },
  keywords:   { type: [String], default: [] },      
  messageText:{ type: String, default: "" },     
  links:      { type: [linkSchema], default: [] },  
  carousel:   { type: [carouselItemSchema], default: [] },
  isActive:   { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
}, { timestamps: true });

automationSchema.index({ ownerId: 1, igMediaId: 1 }, { unique: false });

module.exports = mongoose.model("Automation", automationSchema);
