import handleStaff from "../_handlers/staff.js";

export default async function handler(req, res) {
  const routeParam = req.query?.route;
  const route = Array.isArray(routeParam)
    ? routeParam
    : typeof routeParam === "string" && routeParam.length > 0
      ? [routeParam]
      : [];

  req.staffPath = "/staff" + "/" + route.join("/");

  return handleStaff(req, res);
}
