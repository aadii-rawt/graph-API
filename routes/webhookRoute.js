const router = require("express").Router();
const w = require("../controllers/webhook");

// Verification GET
router.get("/", w.verify);

// Receive POST
router.post("/", w.receive);

module.exports = router;
