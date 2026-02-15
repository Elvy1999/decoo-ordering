import { sendOrderConfirmationSms, sendOrderReadySms } from "./twilio.js";

const PAYMENT_STATUS = Object.freeze({
  UNPAID: "unpaid",
  PAID: "paid",
});

const ORDER_STATUS = Object.freeze({
  NEW: "new",
  COMPLETED: "completed",
});

const normalizeValue = (value) => String(value || "").trim().toLowerCase();

const shouldSendConfirmationSms = (oldOrder, newOrder) => {
  const oldPaymentStatus = normalizeValue(oldOrder?.payment_status);
  const newPaymentStatus = normalizeValue(newOrder?.payment_status);
  const confirmationFlag = newOrder?.confirmation_sms_sent;

  return (
    oldPaymentStatus !== PAYMENT_STATUS.PAID &&
    newPaymentStatus === PAYMENT_STATUS.PAID &&
    confirmationFlag === false
  );
};

const shouldSendReadySms = (oldOrder, newOrder) => {
  const oldStatus = normalizeValue(oldOrder?.status);
  const newStatus = normalizeValue(newOrder?.status);
  const readyFlag = newOrder?.ready_sms_sent;

  return oldStatus !== ORDER_STATUS.COMPLETED && newStatus === ORDER_STATUS.COMPLETED && readyFlag === false;
};

export function queueOrderTransitionSms({ supabase, oldOrder, newOrder }) {
  if (!supabase || !oldOrder || !newOrder) return;
  if (!newOrder.id || oldOrder.id !== newOrder.id) return;

  if (shouldSendConfirmationSms(oldOrder, newOrder)) {
    // Best-effort async send; order updates should not block on SMS provider calls.
    void sendOrderConfirmationSms(supabase, newOrder.id);
  }

  if (shouldSendReadySms(oldOrder, newOrder)) {
    // Best-effort async send; order updates should not block on SMS provider calls.
    void sendOrderReadySms(supabase, newOrder.id);
  }
}

export { ORDER_STATUS, PAYMENT_STATUS };
