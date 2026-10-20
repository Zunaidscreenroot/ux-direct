-- Automatic coaching activation provenance.
-- Safe to apply repeatedly. Keeps legacy/manual review supported while ensuring
-- lessons inserted via the relevance-gated ingestion path are not mislabeled human-approved.
CREATE OR REPLACE FUNCTION public.uxd_brain_review_feedback(
  p_feedback_id uuid,
  p_action text,
  p_review_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  feedback_row public.uxd_brain_feedback%rowtype;
  memory_id uuid;
  normalized_scope text;
  normalized_key text;
  memory_content text;
  memory_structured jsonb;
  action_value text;
  activation_mode text;
  memory_source text;
  memory_confidence numeric;
BEGIN
  action_value := lower(trim(coalesce(p_action, '')));
  IF action_value NOT IN ('approve', 'reject', 'archive') THEN
    RAISE EXCEPTION 'action must be approve, reject, or archive';
  END IF;

  SELECT * INTO feedback_row
  FROM public.uxd_brain_feedback
  WHERE id = p_feedback_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Coaching feedback not found';
  END IF;

  normalized_scope := trim(coalesce(feedback_row.scope_key, 'UX_SHARED_BRAIN'));
  IF normalized_scope = '' THEN normalized_scope := 'UX_SHARED_BRAIN'; END IF;

  activation_mode := CASE
    WHEN feedback_row.metadata #>> '{ingestion,mode}' = 'automatic'
      OR lower(trim(coalesce(p_review_note, ''))) LIKE 'automatically activated after relevance and scope checks%'
      THEN 'automatic'
    ELSE 'manual-review'
  END;
  memory_source := CASE
    WHEN activation_mode = 'automatic' THEN 'automatic-coaching-rule'
    ELSE 'human-reviewed-coaching-rule'
  END;
  memory_confidence := CASE
    WHEN activation_mode = 'automatic' THEN 0.65
    ELSE 0.95
  END;

  IF action_value = 'approve' THEN
    IF trim(coalesce(feedback_row.normalized_rule, '')) = '' THEN
      RAISE EXCEPTION 'A normalized rule is required before activation';
    END IF;

    -- Built-in md5 is sufficient for a non-security deduplication key and does
    -- not depend on pgcrypto being installed in this Neon database.
    normalized_key := md5(
      lower(regexp_replace(normalized_scope || '|' || coalesce(feedback_row.title, '') || '|' || feedback_row.normalized_rule, '\s+', ' ', 'g'))
    );

    memory_content := trim(feedback_row.normalized_rule) ||
      CASE WHEN trim(coalesce(feedback_row.rationale, '')) = '' THEN '' ELSE E'\nRationale: ' || trim(feedback_row.rationale) END;

    memory_structured := jsonb_build_object(
      'scope_key', normalized_scope,
      'feedback_kind', feedback_row.feedback_kind,
      'source_feedback_id', feedback_row.id,
      'source_product', feedback_row.source_product,
      'examples', coalesce(feedback_row.examples, '[]'::jsonb),
      'activation_mode', activation_mode,
      'ingestion', coalesce(feedback_row.metadata->'ingestion', '{}'::jsonb),
      'learning_version', 2
    );

    INSERT INTO public.uxd_memory_items (
      project_key, memory_type, title, content, structured_data, tags,
      source, confidence, status, approved_at, archived_at,
      source_product, source_reference, dedupe_key, valid_from, valid_until
    ) VALUES (
      normalized_scope,
      'coaching_rule',
      left(trim(feedback_row.title), 180),
      left(memory_content, 2400),
      memory_structured,
      coalesce(feedback_row.keywords, '{}'::text[]),
      memory_source,
      memory_confidence,
      'approved',
      now(),
      null,
      feedback_row.source_product,
      'brain-feedback:' || feedback_row.id::text,
      normalized_key,
      now(),
      null
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
    DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      structured_data = excluded.structured_data,
      tags = excluded.tags,
      source = excluded.source,
      confidence = excluded.confidence,
      status = 'approved',
      approved_at = now(),
      archived_at = null,
      source_product = excluded.source_product,
      source_reference = excluded.source_reference,
      valid_from = now(),
      valid_until = null,
      updated_at = now()
    RETURNING id INTO memory_id;

    UPDATE public.uxd_brain_feedback
    SET status = 'approved',
        memory_item_id = memory_id,
        review_note = left(coalesce(p_review_note, ''), 1000),
        reviewed_at = now(),
        updated_at = now()
    WHERE id = p_feedback_id;

    RETURN jsonb_build_object(
      'feedbackId', p_feedback_id,
      'memoryItemId', memory_id,
      'status', 'approved',
      'scopeKey', normalized_scope,
      'activationMode', activation_mode,
      'confidence', memory_confidence
    );
  END IF;

  IF action_value = 'reject' THEN
    IF feedback_row.status = 'approved' THEN
      RAISE EXCEPTION 'An active learning must be archived, not rejected';
    END IF;
    UPDATE public.uxd_brain_feedback
    SET status = 'rejected',
        review_note = left(coalesce(p_review_note, ''), 1000),
        reviewed_at = now(),
        updated_at = now()
    WHERE id = p_feedback_id;
    RETURN jsonb_build_object('feedbackId', p_feedback_id, 'status', 'rejected');
  END IF;

  UPDATE public.uxd_brain_feedback
  SET status = 'archived',
      review_note = left(coalesce(p_review_note, ''), 1000),
      reviewed_at = now(),
      updated_at = now()
  WHERE id = p_feedback_id;

  IF feedback_row.memory_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.uxd_brain_feedback other
    WHERE other.memory_item_id = feedback_row.memory_item_id
      AND other.id <> p_feedback_id
      AND other.status = 'approved'
  ) THEN
    UPDATE public.uxd_memory_items
    SET status = 'archived', archived_at = now(), updated_at = now()
    WHERE id = feedback_row.memory_item_id;
  END IF;

  RETURN jsonb_build_object(
    'feedbackId', p_feedback_id,
    'memoryItemId', feedback_row.memory_item_id,
    'status', 'archived'
  );
END;
$function$;
