alter table public.orders
  add column if not exists confirmation_sms_sent boolean not null default false,
  add column if not exists ready_sms_sent boolean not null default false,
  add column if not exists confirmation_sms_sent_at timestamptz,
  add column if not exists ready_sms_sent_at timestamptz;

-- Legacy backfill for older installs that used placed_sms_sent.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'placed_sms_sent'
  ) then
    update public.orders
    set confirmation_sms_sent = coalesce(placed_sms_sent, false)
    where confirmation_sms_sent is distinct from coalesce(placed_sms_sent, false);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'placed_sms_sent_at'
  ) then
    update public.orders
    set confirmation_sms_sent_at = placed_sms_sent_at
    where confirmation_sms_sent_at is null
      and placed_sms_sent_at is not null;
  end if;
end
$$;
