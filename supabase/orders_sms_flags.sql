alter table public.orders
  add column if not exists placed_sms_sent boolean not null default false,
  add column if not exists ready_sms_sent boolean not null default false,
  add column if not exists placed_sms_sent_at timestamptz,
  add column if not exists ready_sms_sent_at timestamptz;
