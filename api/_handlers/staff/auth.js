import { json } from "../shared.js";

function readBearerToken(req) {
  const rawHeader = req.headers?.authorization;
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof headerValue !== "string") return "";

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!match) return "";
  return String(match[1] || "").trim();
}

export function requireStaff(req, res) {
  const expectedToken = process.env.STAFF_TOKEN;
  const providedToken = readBearerToken(req);

  if (!expectedToken) {
    json(res, 500, { error: "STAFF_TOKEN_MISSING" });
    return false;
  }

  if (!providedToken || providedToken !== expectedToken) {
    json(res, 401, { error: "UNAUTHORIZED" });
    return false;
  }

  return true;
}
