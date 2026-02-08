import handleStaff from "../_handlers/staff.js";

export default function handler(req, res) {
  const route = req.query?.route;

  let suffix = "";
  if (Array.isArray(route) && route.length) suffix = "/" + route.join("/");
  else if (typeof route === "string" && route.trim()) suffix = "/" + route.replace(/^\/+/, "");

  // This mirrors what your global router expects
  req.staffPath = "/staff" + suffix;

  return handleStaff(req, res);
}
