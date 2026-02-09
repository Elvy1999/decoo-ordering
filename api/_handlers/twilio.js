import Twilio from "twilio";

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  return Twilio(sid, token);
}

export async function sendSms(to, body) {
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) throw new Error("TWILIO_PHONE_NUMBER must be set");
  const client = getTwilioClient();
  return client.messages.create({ from, to, body });
}

export async function sendOrderCompletedSms(supabase, orderId) {
  if (!orderId) return;
  try {
    const { data: order, error } = await supabase
      .from("orders")
      .select("id,customer_name,customer_phone,order_code,total_cents,fulfillment_type")
      .eq("id", orderId)
      .single();

    if (error || !order) {
      console.error("Twilio: could not load order for sms", error);
      return;
    }

    const to = String(order.customer_phone || "").trim();
    if (!to) return;

    const name = (order.customer_name || "").trim();
    const code = order.order_code || "";
    const total = typeof order.total_cents === "number" ? (order.total_cents / 100).toFixed(2) : null;

    let body = "";
    if (order.fulfillment_type === "pickup") {
      body = `${name ? name + ", " : ""}your order ${code} is ready for pickup.`;
    } else {
      body = `${name ? name + ", " : ""}your order ${code} has been completed.`;
    }
    if (total) body += ` Total: $${total}.`;
    body += " Thank you for ordering from us!";

    try {
      await sendSms(to, body);
      console.log("Twilio: sent order-completed SMS to", to);
    } catch (err) {
      console.error("Twilio: failed to send SMS", err);
    }
  } catch (err) {
    console.error("Twilio: unexpected error in sendOrderCompletedSms", err);
  }
}
