import handleStaff from "../../../_handlers/staff.js";

function getIdParam(req) {
  const id = req.query?.id;
  if (Array.isArray(id)) return id[0] || "";
  return String(id || "");
}

export default function handler(req, res) {
  const id = getIdParam(req).replace(/^\/+|\/+$/g, "");
  req.staffPath = `/staff/inventory/${id}/toggle`;
  return handleStaff(req, res);
}
