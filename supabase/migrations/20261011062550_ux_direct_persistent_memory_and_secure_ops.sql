-- UX Direct durable operations, plugin bridge, task history, and approved memory.
-- All data is server-only. Keep service-role credentials on the server; never in the browser/plugin.
-- Event summaries/details must not contain raw prompts, credentials, tokens, or full client-document contents.

begin;

-- Remove client-side schema creation rights. Keep public schema usage so the server-only
-- service_role can use Supabase's Data API for explicitly granted tables.
revoke create on schema public from public, anon, authenticated;
grant usage on schema public to service_role;

create table if not exists public.uxd_operational_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  source text not null check (source in ('dashboard', 'figma-plugin', 'backend', 'ai-agent', 'system')),
  event_type text not null check (length(event_type) between 1 and 120),
  status text not null check (status in ('success', 'warning', 'error', 'info')),
  summary text not null check (length(summary) <= 1000),
  request_id text,
  project_key text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  mode text,
  category text,
  action text,
  test_type text check (test_type is null or test_type in ('availability', 'functional', 'not-tested')),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);
create index if not exists uxd_events_time_idx on public.uxd_operational_events (occurred_at desc);
create index if not exists uxd_events_source_time_idx on public.uxd_operational_events (source, occurred_at desc);
create index if not exists uxd_events_request_idx on public.uxd_operational_events (request_id) where request_id is not null;
comment on table public.uxd_operational_events is 'Private audit trail. Store action metadata and safe summaries only, never credentials or raw client prompts.';

create table if not exists public.uxd_plugin_sessions (
  client_id text primary key check (length(client_id) between 8 and 100 and client_id ~ '^[A-Za-z0-9_-]+$'),
  session_token_hash text not null check (session_token_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'offline' check (status in ('online', 'offline')),
  plugin_version text,
  connected_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  disconnected_at timestamptz,
  last_health_run_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);
create index if not exists uxd_plugin_sessions_heartbeat_idx on public.uxd_plugin_sessions (last_heartbeat_at desc);
comment on table public.uxd_plugin_sessions is 'Private plugin presence registry. Stores SHA-256 session-token hashes only; never store raw tokens or Figma file contents.';

create table if not exists public.uxd_plugin_commands (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.uxd_plugin_sessions(client_id) on delete cascade,
  action text not null check (action in ('native-api-health-check')),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'completed', 'failed', 'cancelled', 'expired')),
  requested_from text not null default 'dashboard' check (requested_from in ('dashboard', 'plugin', 'system')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 seconds'),
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  error_summary text check (error_summary is null or length(error_summary) <= 1000),
  idempotency_key text
);
create index if not exists uxd_plugin_commands_session_time_idx on public.uxd_plugin_commands (client_id, created_at desc);
create index if not exists uxd_plugin_commands_queue_idx on public.uxd_plugin_commands (status, expires_at) where status in ('pending', 'claimed');
create unique index if not exists uxd_plugin_commands_one_active_per_session_idx
  on public.uxd_plugin_commands (client_id) where status in ('pending', 'claimed');
comment on table public.uxd_plugin_commands is 'Private durable command queue for explicitly allow-listed, non-destructive plugin operations.';

create table if not exists public.uxd_plugin_health_runs (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.uxd_plugin_sessions(client_id) on delete cascade,
  command_id uuid references public.uxd_plugin_commands(id) on delete set null,
  initiated_from text not null check (initiated_from in ('dashboard', 'plugin')),
  status text not null default 'completed' check (status in ('running', 'completed', 'failed', 'timed_out')),
  passed integer not null default 0 check (passed >= 0),
  failed integer not null default 0 check (failed >= 0),
  not_tested integer not null default 0 check (not_tested >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  report jsonb not null default '{}'::jsonb check (jsonb_typeof(report) = 'object'),
  error_summary text check (error_summary is null or length(error_summary) <= 1000)
);
create index if not exists uxd_health_runs_session_time_idx on public.uxd_plugin_health_runs (client_id, started_at desc);
create index if not exists uxd_health_runs_time_idx on public.uxd_plugin_health_runs (started_at desc);
alter table public.uxd_plugin_sessions
  drop constraint if exists uxd_plugin_sessions_last_health_run_fk;
alter table public.uxd_plugin_sessions
  add constraint uxd_plugin_sessions_last_health_run_fk
  foreign key (last_health_run_id) references public.uxd_plugin_health_runs(id) on delete set null;
comment on table public.uxd_plugin_health_runs is 'Persistent native Plugin API test inventory with honest PASS/FAIL/NOT TESTED levels and individual results.';

create table if not exists public.uxd_task_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  project_key text not null default 'general',
  title text not null check (length(title) <= 240),
  request_summary text not null check (length(request_summary) <= 2000),
  status text not null default 'queued' check (status in ('queued', 'planning', 'planned', 'running', 'completed', 'failed', 'cancelled')),
  mode text,
  provider text,
  model text,
  plan jsonb check (plan is null or jsonb_typeof(plan) = 'object'),
  outcome_summary text check (outcome_summary is null or length(outcome_summary) <= 4000),
  error_summary text check (error_summary is null or length(error_summary) <= 2000),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  cost_amount numeric(12, 6) check (cost_amount is null or cost_amount >= 0),
  cost_currency text default 'INR',
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);
create index if not exists uxd_task_runs_project_time_idx on public.uxd_task_runs (project_key, created_at desc);
create index if not exists uxd_task_runs_status_time_idx on public.uxd_task_runs (status, created_at desc);
comment on table public.uxd_task_runs is 'Private durable task history. Keep only a redacted request summary; do not store raw prompts by default.';

create table if not exists public.uxd_memory_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  project_key text not null default 'general',
  memory_type text not null check (memory_type in ('product_requirement', 'approved_pattern', 'design_decision', 'design_system_rule', 'user_preference', 'research_finding', 'task_outcome', 'open_question')),
  title text not null check (length(title) between 1 and 240),
  content text not null check (length(content) <= 40000),
  structured_data jsonb not null default '{}'::jsonb check (jsonb_typeof(structured_data) = 'object'),
  tags text[] not null default '{}',
  source text not null default 'human-approved' check (source in ('human-approved', 'task-outcome', 'design-review', 'imported')),
  confidence numeric(4, 3) not null default 1.000 check (confidence >= 0 and confidence <= 1),
  status text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  approved_at timestamptz,
  archived_at timestamptz
);
create index if not exists uxd_memory_project_type_idx on public.uxd_memory_items (project_key, memory_type, updated_at desc);
create index if not exists uxd_memory_tags_idx on public.uxd_memory_items using gin (tags);
create index if not exists uxd_memory_search_idx
  on public.uxd_memory_items using gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')));
comment on table public.uxd_memory_items is 'Private long-term product memory. Promote to approved only after review; do not import confidential source documents wholesale.';

-- No browser/mobile role receives a policy or table grant. Backend-only service_role is the only API role.
alter table public.uxd_operational_events enable row level security;
alter table public.uxd_plugin_sessions enable row level security;
alter table public.uxd_plugin_commands enable row level security;
alter table public.uxd_plugin_health_runs enable row level security;
alter table public.uxd_task_runs enable row level security;
alter table public.uxd_memory_items enable row level security;

revoke all on table public.uxd_operational_events, public.uxd_plugin_sessions,
  public.uxd_plugin_commands, public.uxd_plugin_health_runs,
  public.uxd_task_runs, public.uxd_memory_items
  from public, anon, authenticated;
grant select, insert, update, delete on table public.uxd_operational_events,
  public.uxd_plugin_sessions, public.uxd_plugin_commands,
  public.uxd_plugin_health_runs, public.uxd_task_runs,
  public.uxd_memory_items to service_role;

-- Avoid accidental future exposure by default privileges on future objects created as postgres.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- Security Advisor found this existing event-trigger helper callable via the Data API.
-- Its event-trigger behavior remains; public RPC execution is not needed.
revoke all on function public.rls_auto_enable() from public, anon, authenticated;

commit;
