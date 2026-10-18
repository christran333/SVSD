// Vercel entry: every /api/* request is rewritten here (see vercel.json) and handled by the same code as the local server.
const { handleApi } = require("../server.js");
module.exports = (req, res) => {
  const route = String((req.query && req.query.route) || "").replace(/[^a-z]/g, "");
  return handleApi(req, res, "/api/" + route);
};
