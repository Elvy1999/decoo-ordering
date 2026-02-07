const API_BASE = "https://api.clover.com/v3/merchants";

async function cloverFetch(url, accessToken, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    const err = new Error(`Clover API error ${resp.status}`);
    err.status = resp.status;
    err.details = data;
    throw err;
  }
  return data;
}

export async function createCloverOrder({ merchantId, accessToken, title, note, orderTypeId }) {
  const body = {
    state: "open",
    title: title || "Online Order",
  };

  if (note) body.note = note;
  if (orderTypeId) body.orderType = { id: orderTypeId };

  const url = `${API_BASE}/${merchantId}/orders`;
  return cloverFetch(url, accessToken, { method: "POST", body: JSON.stringify(body) });
}

export async function addOnlineOrderLineItem({
  merchantId,
  accessToken,
  cloverOrderId,
  totalCents,
  note,
}) {
  const url = `${API_BASE}/${merchantId}/orders/${cloverOrderId}/line_items`;

  const body = {
    name: "Online Order",
    price: Number(totalCents),
    unitQty: 1,
  };

  if (note) body.note = note;

  return cloverFetch(url, accessToken, { method: "POST", body: JSON.stringify(body) });
}

export async function printCloverOrder({ merchantId, accessToken, cloverOrderId }) {
  const url = `${API_BASE}/${merchantId}/print_event`;

  const body = {
    orderRef: { id: cloverOrderId },
  };

  return cloverFetch(url, accessToken, { method: "POST", body: JSON.stringify(body) });
}
