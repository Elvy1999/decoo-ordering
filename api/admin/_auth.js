import { fail } from "../_shared.js";

export function requireAdmin(req, res) {
  const headerValue = req.headers?.["x-admin-token"];
  const token = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const expected = process.env.ADMIN_TOKEN;

  if (!expected) {
    fail(res, 500, "ADMIN_TOKEN_MISSING", "Server is not configured for admin access.");
    return false;
  }
  //fake comment for redeployment
  if (!token || token !== expected) {
    fail(res, 401, "UNAUTHORIZED", "Admin token required.");
    return false;
  }

  return true;
}
