-- Additional defense in depth: deny browser roles even if future grants are accidentally added.
-- service_role continues to work server-side (it bypasses RLS by design).
begin;

create index if not exists uxd_plugin_health_runs_command_id_idx
  on public.uxd_plugin_health_runs (command_id) where command_id is not null;
create index if not exists uxd_plugin_sessions_last_health_run_idx
  on public.uxd_plugin_sessions (last_health_run_id) where last_health_run_id is not null;

drop policy if exists uxd_deny_client_access on public.uxd_operational_events;
create policy uxd_deny_client_access on public.uxd_operational_events
  for all to anon, authenticated using (false) with check (false);

drop policy if exists uxd_deny_client_access on public.uxd_plugin_sessions;
create policy uxd_deny_client_access on public.uxd_plugin_sessions
  for all to anon, authenticated using (false) with check (false);

drop policy if exists uxd_deny_client_access on public.uxd_plugin_commands;
create policy uxd_deny_client_access on public.uxd_plugin_commands
  for all to anon, authenticated using (false) with check (false);

drop policy if exists uxd_deny_client_access on public.uxd_plugin_health_runs;
create policy uxd_deny_client_access on public.uxd_plugin_health_runs
  for all to anon, authenticated using (false) with check (false);

drop policy if exists uxd_deny_client_access on public.uxd_task_runs;
create policy uxd_deny_client_access on public.uxd_task_runs
  for all to anon, authenticated using (false) with check (false);

drop policy if exists uxd_deny_client_access on public.uxd_memory_items;
create policy uxd_deny_client_access on public.uxd_memory_items
  for all to anon, authenticated using (false) with check (false);

commit;