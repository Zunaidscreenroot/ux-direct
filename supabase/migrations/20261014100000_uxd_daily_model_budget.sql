-- UX Direct: shared rolling 24-hour paid inference budget.
-- The existing reservation table is reused so all Cockpit paid attempts share
-- one transactional budget across concurrent serverless requests.

create index if not exists uxd_model_hourly_reservations_scope_time_idx
  on public.uxd_model_hourly_reservations (scope, reserved_at desc);

create or replace function public.reserve_uxd_model_daily_budget(
  p_scope text,
  p_amount_inr numeric,
  p_daily_limit_inr numeric,
  p_model text,
  p_request_id text
)
returns table(allowed boolean, spent_inr numeric, projected_inr numeric, limit_inr numeric, remaining_inr numeric)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_spent numeric(12,6);
begin
  if p_scope is null or length(p_scope) = 0 or length(p_scope) > 100 then
    raise exception 'Invalid budget scope';
  end if;
  if p_amount_inr is null or p_amount_inr <= 0 or p_amount_inr > 50 then
    raise exception 'Invalid reservation amount';
  end if;
  if p_daily_limit_inr is null or p_daily_limit_inr <= 0 or p_daily_limit_inr > 50 then
    raise exception 'Invalid daily budget limit';
  end if;
  if p_request_id is null or length(p_request_id) = 0 or length(p_request_id) > 120 then
    raise exception 'Invalid request id';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_scope, 0));

  delete from public.uxd_model_hourly_reservations
   where scope = p_scope and reserved_at < now() - interval '24 hours';

  select coalesce(sum(r.amount_inr), 0)
    into v_spent
    from public.uxd_model_hourly_reservations r
   where r.scope = p_scope and r.reserved_at > now() - interval '24 hours';

  if v_spent + p_amount_inr <= p_daily_limit_inr then
    insert into public.uxd_model_hourly_reservations(scope, amount_inr, model_id, request_id, state)
    values (p_scope, p_amount_inr, left(coalesce(p_model, 'unknown'), 160), left(p_request_id, 120), 'reserved');
    return query select true, v_spent, v_spent + p_amount_inr, p_daily_limit_inr, greatest(0, p_daily_limit_inr - v_spent - p_amount_inr);
  else
    return query select false, v_spent, v_spent + p_amount_inr, p_daily_limit_inr, greatest(0, p_daily_limit_inr - v_spent);
  end if;
end;
$function$;

create or replace function public.uxd_model_daily_budget_status(
  p_scope text,
  p_daily_limit_inr numeric
)
returns table(spent_inr numeric, limit_inr numeric, remaining_inr numeric, window_minutes integer)
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select
    coalesce(sum(r.amount_inr), 0)::numeric as spent_inr,
    p_daily_limit_inr::numeric as limit_inr,
    greatest(0, p_daily_limit_inr - coalesce(sum(r.amount_inr), 0))::numeric as remaining_inr,
    1440::integer as window_minutes
  from public.uxd_model_hourly_reservations r
  where r.scope = p_scope
    and r.reserved_at > now() - interval '24 hours';
$function$;

create or replace function public.settle_uxd_model_daily_budget(
  p_scope text,
  p_request_id text,
  p_actual_amount_inr numeric
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_updated integer;
begin
  if p_scope is null or length(p_scope) = 0 or length(p_scope) > 100 then
    raise exception 'Invalid budget scope';
  end if;
  if p_request_id is null or length(p_request_id) = 0 or length(p_request_id) > 120 then
    raise exception 'Invalid request id';
  end if;
  if p_actual_amount_inr is null or p_actual_amount_inr < 0 or p_actual_amount_inr > 50 then
    raise exception 'Invalid settled amount';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_scope, 0));

  update public.uxd_model_hourly_reservations
     set amount_inr = greatest(p_actual_amount_inr, 0.0001),
         state = 'completed'
   where scope = p_scope
     and request_id = p_request_id
     and state = 'reserved';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$function$;

revoke all on function public.reserve_uxd_model_daily_budget(text, numeric, numeric, text, text) from public, anon, authenticated;
revoke all on function public.uxd_model_daily_budget_status(text, numeric) from public, anon, authenticated;
revoke all on function public.settle_uxd_model_daily_budget(text, text, numeric) from public, anon, authenticated;
grant execute on function public.reserve_uxd_model_daily_budget(text, numeric, numeric, text, text) to service_role;
grant execute on function public.uxd_model_daily_budget_status(text, numeric) to service_role;
grant execute on function public.settle_uxd_model_daily_budget(text, text, numeric) to service_role;
