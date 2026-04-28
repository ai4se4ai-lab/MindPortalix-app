create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  title text not null default 'New conversation',
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  conversation_id uuid references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null,
  agent text,
  model text,
  score numeric,
  created_at timestamptz not null default now()
);

create index if not exists messages_user_id_created_at_idx
  on messages (user_id, created_at);

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  topic text not null,
  summary text not null,
  importance int not null default 3 check (importance between 1 and 5),
  last_accessed timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists agent_logs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  agent text not null,
  input jsonb not null,
  output jsonb,
  latency_ms int,
  model text,
  created_at timestamptz not null default now()
);

alter table conversations enable row level security;
alter table messages enable row level security;
alter table memories enable row level security;
alter table agent_logs enable row level security;

create policy "Users manage own conversations"
  on conversations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users manage own memories"
  on memories for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users manage own messages"
  on messages for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users read logs in own conversations"
  on agent_logs for select
  using (
    exists (
      select 1 from conversations
      where conversations.id = agent_logs.conversation_id
      and conversations.user_id = auth.uid()
    )
  );
