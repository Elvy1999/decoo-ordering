import { ok, fail, methodNotAllowed, supabaseServerClient } from "../shared.js";
import { requireStaff } from "./auth.js";

const normalizeCategory = (value) => {
  const category = String(value || "").trim();
  return category || "Uncategorized";
};

const normalizeSort = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return Number.MAX_SAFE_INTEGER;
  return num;
};

export default async function handler(req, res) {
  if (!requireStaff(req, res)) return;
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  try {
    const supabase = supabaseServerClient();
    const { data, error } = await supabase
      .from("menu_items")
      .select("id,name,category,in_stock,price_cents,badge,is_active,sort_order")
      .eq("is_active", true)
      .order("category", { ascending: true })
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true });

    if (error) throw error;

    const groups = new Map();
    for (const row of data || []) {
      const category = normalizeCategory(row?.category);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(row);
    }

    const sections = Array.from(groups.keys())
      .sort((a, b) => a.localeCompare(b))
      .map((category) => {
        const sortedRows = (groups.get(category) || []).slice().sort((a, b) => {
          const aOrder = normalizeSort(a?.sort_order);
          const bOrder = normalizeSort(b?.sort_order);
          if (aOrder !== bOrder) return aOrder - bOrder;
          return String(a?.name || "").localeCompare(String(b?.name || ""));
        });

        return {
          category,
          items: sortedRows.map((row) => ({
            id: row.id,
            name: row.name,
            in_stock: Boolean(row.in_stock),
            price_cents: Number(row.price_cents || 0),
            badge: row.badge || "",
          })),
        };
      });

    return ok(res, sections);
  } catch (err) {
    console.error("Failed to load inventory sections:", err);
    return fail(res, 500, "STAFF_INVENTORY_LOAD_FAILED", "Could not load inventory sections.");
  }
}
