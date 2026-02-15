# DecoO Ordering

Online ordering app for DecoO Restaurant with:
- customer checkout flow
- Supabase-backed menu/orders/settings
- Clover payment integration
- staff/admin management endpoints
- Twilio SMS updates for paid + ready order states

## Stack

- Frontend: static HTML/CSS/JS in `public/`
- API: Vercel serverless functions in `api/`
- Database: Supabase (Postgres)
- Payments: Clover eCommerce + Clover POS sync
- Maps/Delivery validation: Mapbox Geocoding API
- SMS: Twilio

## Project structure

```text
decoo-ordering/
  api/                 # serverless API routes + handlers
  public/              # customer/admin/staff frontend pages
  supabase/            # SQL migration helpers
  server/              # legacy Express server (local/older flow)
  TWILIO.md            # Twilio-specific setup notes
```

## Core order flow

1. Customer submits order (`/api/orders`) → order is created as:
   - `payment_status = unpaid`
   - `status = new`
2. Payment completes (`/api/payments/iframe/charge`) → `payment_status` becomes `paid`
3. On transition to `paid`, confirmation SMS is queued (best effort)
4. Staff/Admin marks order completed (`/api/staff/orders/:id/complete` or admin update)
5. On transition to `completed`, ready-for-pickup SMS is queued (best effort)

SMS failures do **not** block payment or status updates.

## API overview

### Public

- `GET /api/menu`
- `GET /api/settings`
- `GET /api/health`
- `POST /api/validate-delivery`
- `POST /api/validate-promo`
- `POST /api/orders`
- `POST /api/payments/iframe/charge`
- `GET /api/payments/config`

### Staff (Bearer token)

- `GET /api/staff/orders`
- `POST /api/staff/orders/:id/complete`
- `GET /api/staff/inventory/sections`
- `POST /api/staff/inventory/:id/toggle`

### Admin (`x-admin-token` header)

- `GET /api/admin/menu`
- `PATCH /api/admin/menu-item`
- `POST /api/admin/orders`
- `GET/PATCH /api/admin/order`
- `GET/PATCH /api/admin/settings`
- `GET /api/admin/stats/summary`
- `GET /api/admin/promo-codes`
- `POST /api/admin/promo-code`
- `POST /api/admin/reprint`

## Environment variables

Create `.env.local` (or configure these in Vercel):

### Required

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_TOKEN`
- `STAFF_TOKEN`
- `CLOVER_ECOMM_PUBLIC_KEY`
- `CLOVER_ECOMM_PRIVATE_KEY`
- `CLOVER_MERCHANT_ID`
- `CLOVER_CLIENT_ID`
- `CLOVER_CLIENT_SECRET`
- `CLOVER_REDIRECT_URI`
- `RESTAURANT_LAT`
- `RESTAURANT_LNG`

### Required when delivery is enabled

- `MAPBOX_TOKEN`

### Required for SMS

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER` (E.164 format, e.g. `+15551234567`)

Backward compatibility: `TWILIO_PHONE_NUMBER` is accepted if `TWILIO_FROM_NUMBER` is not set.

## Database notes

- Ensure your Supabase schema includes `orders`, `order_items`, `menu_items`, `settings`, and promo-related tables used by handlers.
- For SMS idempotency flags, run:
  - `supabase/orders_sms_flags.sql`

See `TWILIO.md` for full SMS behavior and migration details.

## Local development

Install dependencies:

```bash
npm install
```

Run serverless routes locally (recommended):

```bash
npx vercel dev
```

Then open:
- `http://localhost:3000/` (customer site)

## Legacy Express server (optional)

There is also an older Express app under `server/`.

```bash
cd server
npm install
npm start
```

Use this only if you explicitly want the legacy Node server flow.

## Deployment

This project is structured for Vercel:
- `public/` serves static assets
- `api/` contains serverless endpoints

Configure all environment variables in the Vercel project settings before deploying.

## Twilio behavior summary

- Confirmation SMS: sent when `payment_status` transitions to `paid`
- Ready SMS: sent when `status` transitions to `completed`
- Duplicate prevention via SMS flag columns on `orders`
- Phone numbers normalized to E.164 before send
- Retries with backoff on SMS provider errors

Detailed notes: see `TWILIO.md`.
