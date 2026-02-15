Twilio setup for DecoO ordering

Required environment variables:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER` (E.164, ex: `+15551234567`)

Backward compatibility:

- `TWILIO_PHONE_NUMBER` is still accepted as a fallback if `TWILIO_FROM_NUMBER` is not set.

Also required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Run/install:

```bash
cd decoo-ordering
npm install
```

Database columns for idempotency:

```sql
alter table public.orders
  add column if not exists confirmation_sms_sent boolean not null default false,
  add column if not exists ready_sms_sent boolean not null default false,
  add column if not exists confirmation_sms_sent_at timestamptz,
  add column if not exists ready_sms_sent_at timestamptz;
```

Behavior

- Split status model:
  - `payment_status`:
    - `unpaid` = payment not confirmed.
    - `paid` = payment confirmed by payment verification flow.
  - `status`:
    - `new` = active/preparing order.
    - `completed` = ready for pickup (set by staff/admin only).

- Order confirmation SMS:
  - Trigger: only when `orders.payment_status` transitions via update from non-`paid` to `paid`.
  - Never sent on insert.
  - Body format:
    - `Order #<id> confirmed!`
    - one line per item: `<Item Name> * <Quantity>`
    - `Total: $<amount>`
    - `Thank you for ordering Decoo Restaurant!`
  - Duplicate item names are aggregated before rendering.
  - Message is capped to safe length; if too long, only top lines are kept with `(+ more items)`.

- Order ready SMS:
  - Trigger: only when `orders.status` transitions via update from non-`completed` to `completed`.
  - Never sent on insert.
  - Body:
    - `Order #<id> is ready for pickup!`
    - `Thank you for choosing Decoo Restaurant.`

- Idempotency:
  - `confirmation_sms_sent` and `ready_sms_sent` are checked before sending.
  - Flags are marked true only after successful provider send.
  - Legacy installs using `placed_sms_sent` remain supported until migrated.

- Reliability/safety:
  - Phone numbers are normalized to E.164 before sending.
  - Missing/invalid phone numbers are skipped with logs.
  - SMS provider errors use retry with backoff.
  - SMS failures never block checkout or status updates.
