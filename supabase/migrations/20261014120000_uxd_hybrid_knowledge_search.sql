-- Hybrid semantic + keyword retrieval for UX Direct.
-- Generated full-text vectors are supplementary to pgvector embeddings; embeddings remain enabled.
alter table public.uxd_knowledge_documents
  add column if not exists search_vector tsvector
  generated always as (to_tsvector('english'::regconfig, coalesce(title, ''))) stored;

alter table public.uxd_knowledge_chunks
  add column if not exists search_vector tsvector
  generated always as (to_tsvector('english'::regconfig, coalesce(content, ''))) stored;

create index if not exists uxd_knowledge_documents_search_vector_gin_idx
  on public.uxd_knowledge_documents using gin (search_vector);

create index if not exists uxd_knowledge_chunks_search_vector_gin_idx
  on public.uxd_knowledge_chunks using gin (search_vector);

create or replace function public.search_uxd_knowledge_keyword(
  p_project_key text,
  p_query text,
  p_match_count integer default 6
)
returns table(
  chunk_id uuid,
  document_id uuid,
  project_key text,
  title text,
  content text,
  source_url text,
  source_authority text,
  similarity real,
  metadata jsonb
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_query tsquery;
  v_terms_query tsquery;
  v_query_text text;
begin
  if p_project_key is null or p_project_key not in ('DMI_HFC', 'UJJIVAN_SFB', 'INDIA_BFCI_SHARED') then
    raise exception 'Invalid UX Direct knowledge project namespace';
  end if;

  v_query := websearch_to_tsquery('english'::regconfig, left(coalesce(p_query, ''), 4000));
  select string_agg(dedup.query_text, ' | ' order by dedup.first_ordinal)
    into v_query_text
    from (
      select token_queries.query_text, min(token_queries.ordinality) as first_ordinal
      from (
        select
          plainto_tsquery('english'::regconfig, tokens.term)::text as query_text,
          tokens.ordinality
        from regexp_split_to_table(left(coalesce(p_query, ''), 4000), '[^[:alnum:]]+')
          with ordinality as tokens(term, ordinality)
        where length(tokens.term) > 1
        order by tokens.ordinality
        limit 40
      ) token_queries
      where numnode(token_queries.query_text::tsquery) > 0
      group by token_queries.query_text
    ) dedup;

  if v_query_text is null or length(trim(v_query_text)) = 0 then
    return;
  end if;
  v_terms_query := v_query_text::tsquery;

  return query
    select
      c.id,
      d.id,
      c.project_key,
      d.title,
      c.content,
      d.source_url,
      d.source_authority,
      (
        ts_rank_cd(d.search_vector, v_terms_query) +
        ts_rank_cd(c.search_vector, v_terms_query) +
        case when numnode(v_query) > 0 and d.search_vector @@ v_query then 0.25 else 0 end +
        case when numnode(v_query) > 0 and c.search_vector @@ v_query then 0.25 else 0 end
      )::real as similarity,
      c.metadata || d.metadata as metadata
    from public.uxd_knowledge_chunks c
    join public.uxd_knowledge_documents d on d.id = c.document_id
    where d.status = 'approved'
      and (
        c.project_key = p_project_key
        or (p_project_key in ('DMI_HFC', 'UJJIVAN_SFB') and c.project_key = 'INDIA_BFCI_SHARED')
      )
      and (d.search_vector @@ v_terms_query or c.search_vector @@ v_terms_query)
    order by (
        ts_rank_cd(d.search_vector, v_terms_query) +
        ts_rank_cd(c.search_vector, v_terms_query) +
        case when numnode(v_query) > 0 and d.search_vector @@ v_query then 0.25 else 0 end +
        case when numnode(v_query) > 0 and c.search_vector @@ v_query then 0.25 else 0 end
      ) desc,
      d.updated_at desc,
      c.chunk_index asc
    limit greatest(1, least(coalesce(p_match_count, 6), 10));
end;
$function$;

revoke all on function public.search_uxd_knowledge_keyword(text, text, integer) from public, anon, authenticated;
grant execute on function public.search_uxd_knowledge_keyword(text, text, integer) to service_role;
