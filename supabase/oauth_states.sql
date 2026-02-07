create table if not exists oauth_states (
  state text primary key,
  created_at timestamptz not null default now()
);

