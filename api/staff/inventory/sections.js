import handleStaff from "../../_handlers/staff.js";

export default function handler(req, res) {
  req.staffPath = "/staff/inventory/sections";
  return handleStaff(req, res);
}
