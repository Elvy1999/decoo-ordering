# DecoO Ordering

DecoO Ordering is a full-stack restaurant ordering platform I built to handle real operations, not just a demo checkout form. It combines customer ordering, staff workflows, live inventory controls, admin tools, payment processing, and SMS status updates in one end-to-end system.

## Full-stack ownership

- **Frontend:** built role-specific interfaces for customer checkout, staff execution, inventory actions, and admin controls.
- **Backend:** designed serverless APIs, business rules, authorization boundaries, and order-state transitions.
- **Data:** modeled order lifecycle states and idempotent SMS flags in Supabase/Postgres.
- **Integrations:** implemented Clover payment/POS flows, Twilio messaging, and Mapbox delivery validation.
- **Deployment architecture:** structured the project for production-oriented serverless hosting on Vercel.

## Project highlights

- Built a complete order lifecycle from cart to payment to fulfillment.
- Designed separate role-based interfaces for customers, staff, and admin users.
- Implemented resilient payment + messaging flows where non-critical failures do not block order progression.
- Structured backend as serverless APIs for clean separation of concerns, scalability, and deployability.

## What I built

### Customer ordering experience

- Responsive web ordering interface with menu browsing and cart management.
- Pickup and delivery support with delivery-radius validation.
- Promo code and discount handling before payment.
- Clover iframe payment integration tied directly to order state transitions.

### Staff workflow

- Staff queue for active orders.
- One-step completion updates to move orders from preparing to ready.
- Auth-protected staff endpoints with scoped capabilities.

### Inventory management

- Dedicated inventory view grouped by sections for faster decision-making.
- Real-time in-stock toggle controls to prevent unavailable items from being sold.
- Staff-facing inventory endpoints separated from customer routes.

### Admin dashboard

- Admin tooling for menu updates, order lookup, status edits, promo management, and reprint actions.
- Daily summary reporting endpoint for operational visibility.
- Token-based admin authorization for protected actions.

## How the ordering system works

1. Customer submits order.
2. Backend creates order as `payment_status = unpaid` and `status = new`.
3. Clover payment route processes charge and updates order to `payment_status = paid`.
4. Payment transition queues confirmation SMS (best effort, non-blocking).
5. Staff/admin marks order completed.
6. Completion transition queues ready-for-pickup SMS (best effort, non-blocking).

This transition-based model keeps status updates reliable and prevents duplicate SMS sends.

## Engineering decisions that improved reliability

- **State-driven automation:** SMS triggers are tied to explicit status/payment transitions instead of one-off calls.
- **Idempotency controls:** confirmation/ready SMS flags prevent duplicate notifications.
- **Graceful degradation:** SMS failures are logged and retried but never block checkout or status updates.
- **Async side effects:** POS sync and printing run best-effort so customer-facing payment responses stay fast.
- **Input normalization/validation:** phone, address, and order payload validation reduce bad writes and downstream errors.

## Architecture

- Frontend: static HTML/CSS/JS (`public/`)
- Backend: Vercel serverless routes + handlers (`api/`)
- Data layer: Supabase/Postgres
- Integrations: Clover (payments/POS), Twilio (order SMS), Mapbox (delivery validation)

## Tech stack

- JavaScript (ES modules)
- Supabase
- Clover APIs
- Twilio
- Mapbox
- Vercel serverless functions

## Repository structure

```text
decoo-ordering/
  api/                 # serverless API routes + business logic handlers
  public/              # customer, staff, admin, and inventory web UIs
  supabase/            # SQL migration helpers (including SMS flag migrations)
  TWILIO.md            # Twilio behavior and setup notes
```

## Why this project matters (for full-stack roles)

This project demonstrates product-minded full-stack execution: I designed for real restaurant constraints (order state consistency, inventory accuracy, operational speed, and communication reliability), then implemented the platform end-to-end across frontend UX, backend business logic, database workflows, third-party integrations, and deployment-ready architecture.
