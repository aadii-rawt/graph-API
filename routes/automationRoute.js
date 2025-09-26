const router = require("express").Router();
const c = require("../controllers/automation");

router.post("/", c.createAutomation);
router.get("/", c.listAutomations);
router.get("/:id", c.getAutomation);
router.patch("/:id", c.updateAutomation);
router.delete("/:id", c.deleteAutomation);

module.exports = router;
