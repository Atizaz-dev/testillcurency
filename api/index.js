/**
 * Vercel serverless entry — single Express app handles /api/* and static files from public/.
 */
const getApp = require("../server");

module.exports = async (req, res) => {
  const u = new URL(req.url, "https://local");
  const forwardedPath = u.searchParams.get("path");
  if (forwardedPath !== null) {
    const qs = new URLSearchParams(u.searchParams);
    qs.delete("path");
    const normalized = forwardedPath ? `/${forwardedPath.replace(/^\/+/, "")}` : "/";
    req.url = normalized + (qs.toString() ? `?${qs.toString()}` : "");
  }
  const app = await getApp();
  return app(req, res);
};
