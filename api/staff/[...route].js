import handleStaff from "../_handlers/staff.js";

export default async function handler(req, res) {
  const routeParam = req.query?.route;
  const route = Array.isArray(routeParam)
    ? routeParam
    : typeof routeParam === "string" && routeParam.length > 0
      ? [routeParam]
      : [];

  const fullPath = "/staff" + "/" + route.join("/");
  req.staffPath = fullPath;

  return handleStaff(req, res);
}
