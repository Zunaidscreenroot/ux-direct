create table if not exists public.uxd_model_learning_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  request_id text not null,
  capability text not null check (length(capability) between 1 and 80),
  model_id text not null check (length(model_id) between 1 and 200),
  model_tier text not null check (model_tier = any (array['free-tier'::text, 'paid'::text])),
  outcome text not null check (outcome = any (array['usable'::text, 'validated'::text, 'validation_failure'::text, 'provider_error'::text, 'budget_blocked'::text])),
  validation_passed boolean not null default false,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  estimated_cost_usd numeric(14,8) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  observed_cost_usd numeric(14,8) check (observed_cost_usd is null or observed_cost_usd >= 0),
  prompt_tokens integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
  total_tokens integer check (total_tokens is null or total_tokens >= 0),
  operation_profile jsonb not null default '{}'::jsonb check (jsonb_typeof(operation_profile) = 'object'),
  error_category text check (error_category is null or length(error_category) <= 80)
);

create index if not exists uxd_model_learning_capability_time_idx
  on public.uxd_model_learning_events (capability, created_at desc);
create index if not exists uxd_model_learning_model_time_idx
  on public.uxd_model_learning_events (model_id, created_at desc);

alter table public.uxd_model_learning_events enable row level security;
revoke all on table public.uxd_model_learning_events from anon, authenticated;
grant all on table public.uxd_model_learning_events to service_role;

comment on table public.uxd_model_learning_events is
  'Private model-performance memory for UX Direct. Stores outcomes, token/cost metadata and structural counts only; never raw prompts, screenshots, or Figma contents.';