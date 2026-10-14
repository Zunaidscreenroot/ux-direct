-- UX Direct: bounded machine-readable run traces for multi-model orchestration.
-- Private artifacts are accessible through server-side service-role helpers only.
create table if not exists public.uxd_run_traces (
  run_id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  project_key text not null check (char_length(project_key) <= 80),
  capability text not null check (char_length(capability) <= 80),
  mode text not null check (mode in ('action', 'explain')),
  status text not null check (status in ('running', 'awaiting_confirmation', 'completed', 'failed', 'cancelled')),
  intent_summary text not null default '' check (char_length(intent_summary) <= 600),
  protocol_version integer not null default 1,
  stages jsonb not null default '[]'::jsonb,
  artifacts jsonb not null default '{}'::jsonb,
  total_prompt_tokens integer,
  total_completion_tokens integer,
  estimated_cost_usd numeric(12, 8),
  observed_cost_usd numeric(12, 8),
  execution_result jsonb
);

create index if not exists uxd_run_traces_project_created_idx
  on public.uxd_run_traces (project_key, created_at desc);
create index if not exists uxd_run_traces_status_created_idx
  on public.uxd_run_traces (status, created_at desc);

alter table public.uxd_run_traces enable row level security;
revoke all on public.uxd_run_traces from anon, authenticated;
grant select, insert, update on public.uxd_run_traces to service_role;

comment on table public.uxd_run_traces is
  'Bounded UXD-IR stage traces and validated artifacts. Does not store screenshots, provider credentials, or model-private chain-of-thought.';
