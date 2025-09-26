const mongoose = require("mongoose");

const sendLogSchema = new mongoose.Schema({
  automationId: { type: mongoose.Schema.Types.ObjectId, ref: "Automation", required: true },
  commenterIgUserId: { type: String, required: true },
  igCommentId: { type: String, required: true }, 
  sentAt: { type: Date, default: Date.now },
}, { timestamps: true });

sendLogSchema.index({ automationId: 1, commenterIgUserId: 1 }, { unique: true });

module.exports = mongoose.model("SendLog", sendLogSchema);
