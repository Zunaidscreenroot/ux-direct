BEGIN;

ALTER TABLE public.uxd_task_runs
  ADD COLUMN IF NOT EXISTS retrieval jsonb,
  ADD COLUMN IF NOT EXISTS lesson jsonb,
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'attempted';
ALTER TABLE public.uxd_task_runs DROP CONSTRAINT IF EXISTS uxd_task_runs_outcome_check;
ALTER TABLE public.uxd_task_runs ADD CONSTRAINT uxd_task_runs_outcome_check
  CHECK (outcome = ANY(ARRAY['attempted','succeeded','verified','failed']::text[]));

ALTER TABLE public.uxd_memory_items
  ADD COLUMN IF NOT EXISTS evidence_count integer NOT NULL DEFAULT 1;
ALTER TABLE public.uxd_memory_items DROP CONSTRAINT IF EXISTS uxd_memory_items_evidence_count_check;
ALTER TABLE public.uxd_memory_items ADD CONSTRAINT uxd_memory_items_evidence_count_check CHECK (evidence_count >= 1);

ALTER TABLE public.uxd_memory_items DROP CONSTRAINT IF EXISTS uxd_memory_items_source_check;
ALTER TABLE public.uxd_memory_items ADD CONSTRAINT uxd_memory_items_source_check
  CHECK (source = ANY(ARRAY[
    'human-approved','task-outcome','design-review','imported','chatgpt-coaching',
    'ux-audit','figma-plugin','knowledge-import','evaluation',
    'human-approved-coaching-rule','automatic-coaching-rule','task-outcome-auto'
  ]::text[]));

CREATE OR REPLACE FUNCTION public.uxd_brain_mark_used(ids uuid[])
RETURNS integer
LANGUAGE sql
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH updated AS (
    UPDATE public.uxd_memory_items
    SET usage_count = usage_count + 1, last_used_at = now(), updated_at = now()
    WHERE id = ANY(coalesce(ids, '{}'::uuid[])) AND status = 'approved'
    RETURNING 1
  )
  SELECT count(*)::integer FROM updated;
$function$;

CREATE OR REPLACE FUNCTION public.uxd_brain_capture_task_lesson(
  p_scope text, p_memory_type text, p_title text, p_content text, p_tags text[], p_dedupe_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  memory_id uuid;
  was_inserted boolean;
  old_pattern record;
  overlap_count integer;
  union_count integer;
  new_confidence numeric;
  new_status text;
BEGIN
  IF p_scope = 'UX_SHARED_BRAIN' OR p_memory_type NOT IN ('approved_pattern','failure_pattern')
     OR length(trim(coalesce(p_title,''))) < 8 OR length(trim(coalesce(p_content,''))) NOT BETWEEN 24 AND 600
     OR p_dedupe_key !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'Task lesson failed scope or content validation';
  END IF;

  INSERT INTO public.uxd_memory_items (
    project_key, memory_type, title, content, structured_data, tags, source,
    confidence, status, approved_at, source_product, source_reference, dedupe_key,
    valid_from, evidence_count
  ) VALUES (
    p_scope, p_memory_type, trim(p_title), trim(p_content),
    jsonb_build_object('learning_origin','verified-task-outcome','requires_human_approval',false),
    coalesce(p_tags,'{}'::text[]), 'task-outcome-auto', 0.6, 'approved', now(),
    'figma-plugin', 'task-outcome-auto', p_dedupe_key, now(), 1
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
  DO UPDATE SET evidence_count = public.uxd_memory_items.evidence_count + 1,
                confidence = least(0.95, public.uxd_memory_items.confidence + 0.05),
                updated_at = now()
  RETURNING id, (xmax = 0) INTO memory_id, was_inserted;

  IF was_inserted AND p_memory_type = 'failure_pattern' THEN
    FOR old_pattern IN
      SELECT id, confidence, status, tags
      FROM public.uxd_memory_items
      WHERE project_key = p_scope AND memory_type = 'approved_pattern'
        AND status = 'approved' AND tags = coalesce(p_tags,'{}'::text[])
    LOOP
      SELECT count(*) INTO overlap_count
      FROM (SELECT unnest(coalesce(p_tags,'{}'::text[])) AS keyword
            INTERSECT SELECT unnest(coalesce(old_pattern.tags,'{}'::text[]))) matches;
      SELECT count(*) INTO union_count
      FROM (SELECT unnest(coalesce(p_tags,'{}'::text[])) AS keyword
            UNION SELECT unnest(coalesce(old_pattern.tags,'{}'::text[]))) keywords;
      IF union_count > 0 AND overlap_count::numeric / union_count >= 0.6 THEN
        new_confidence := greatest(0, old_pattern.confidence - 0.1);
        new_status := CASE WHEN new_confidence < 0.3 THEN 'archived' ELSE 'approved' END;
        UPDATE public.uxd_memory_items
        SET confidence = new_confidence, status = new_status,
            archived_at = CASE WHEN new_status = 'archived' THEN now() ELSE archived_at END,
            updated_at = now()
        WHERE id = old_pattern.id;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('memory_id', memory_id, 'deduplicated', NOT was_inserted, 'inserted', was_inserted);
END;
$function$;

CREATE OR REPLACE FUNCTION public.uxd_task_claim_lesson(p_task_run_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.uxd_task_runs
  SET lesson = jsonb_build_object('status','processing'), updated_at = now()
  WHERE id = p_task_run_id AND lesson IS NULL;
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.uxd_brain_mark_used(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.uxd_brain_capture_task_lesson(text,text,text,text,text[],text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.uxd_task_claim_lesson(uuid) FROM PUBLIC;

COMMIT;
