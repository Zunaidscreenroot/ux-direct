-- UX Direct scoped knowledge RAG for DMI HFC, Ujjivan SFB, and shared Indian BFCI sources.
create extension if not exists vector with schema extensions;

create table if not exists public.uxd_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  project_key text not null check (project_key = any (array['DMI_HFC'::text, 'UJJIVAN_SFB'::text, 'INDIA_BFCI_SHARED'::text])),
  title text not null check (length(title) between 1 and 300),
  source_url text,
  source_type text not null default 'document' check (source_type = any (array['brief'::text, 'figma_reference'::text, 'design_decision'::text, 'regulation'::text, 'research'::text, 'design_system'::text, 'document'::text, 'quality_example'::text)),
  source_authority text not null default 'internal',
  published_at date,
  effective_at date,
  last_verified_at date,
  version_label text,
  status text not null default 'draft' check (status = any (array['draft'::text, 'approved'::text, 'archived'::text])),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create index if not exists uxd_knowledge_documents_project_status_idx
  on public.uxd_knowledge_documents (project_key, status, updated_at desc);

create table if not exists public.uxd_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  document_id uuid not null references public.uxd_knowledge_documents(id) on delete cascade,
  project_key text not null check (project_key = any (array['DMI_HFC'::text, 'UJJIVAN_SFB'::text, 'INDIA_BFCI_SHARED'::text])),
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (length(content) between 1 and 12000),
  content_hash text not null check (length(content_hash) between 1 and 128),
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  unique(document_id, chunk_index)
);

create index if not exists uxd_knowledge_chunks_project_idx
  on public.uxd_knowledge_chunks (project_key, document_id);
create index if not exists uxd_knowledge_chunks_embedding_hnsw_idx
  on public.uxd_knowledge_chunks using hnsw (embedding extensions.vector_cosine_ops);

alter table public.uxd_knowledge_documents enable row level security;
alter table public.uxd_knowledge_chunks enable row level security;
revoke all on table public.uxd_knowledge_documents from anon, authenticated;
revoke all on table public.uxd_knowledge_chunks from anon, authenticated;
grant all on table public.uxd_knowledge_documents to service_role;
grant all on table public.uxd_knowledge_chunks to service_role;

create or replace function public.match_uxd_knowledge(
  p_query_embedding extensions.vector(1536),
  p_project_key text,
  p_match_count integer default 6,
  p_min_similarity real default 0.28
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
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
begin
  if p_project_key is null or p_project_key not in ('DMI_HFC', 'UJJIVAN_SFB', 'INDIA_BFCI_SHARED') then
    raise exception 'Invalid UX Direct knowledge project namespace';
  end if;

  return query
    select
      c.id,
      d.id,
      c.project_key,
      d.title,
      c.content,
      d.source_url,
      d.source_authority,
      (1 - (c.embedding <=> p_query_embedding))::real as similarity,
      c.metadata || d.metadata as metadata
    from public.uxd_knowledge_chunks c
    join public.uxd_knowledge_documents d on d.id = c.document_id
    where d.status = 'approved'
      and c.embedding is not null
      and (
        c.project_key = p_project_key
        or (p_project_key in ('DMI_HFC', 'UJJIVAN_SFB') and c.project_key = 'INDIA_BFCI_SHARED')
      )
      and (1 - (c.embedding <=> p_query_embedding)) >= greatest(0, least(coalesce(p_min_similarity, 0.28), 1))
    order by c.embedding <=> p_query_embedding
    limit greatest(1, least(coalesce(p_match_count, 6), 10));
end;
$function$;

revoke all on function public.match_uxd_knowledge(extensions.vector, text, integer, real) from public, anon, authenticated;
grant execute on function public.match_uxd_knowledge(extensions.vector, text, integer, real) to service_role;
