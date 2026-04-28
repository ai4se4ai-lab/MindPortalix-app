# Supabase Schema

## Tables

```sql
create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  title text not null default 'New conversation',
  created_at timestamptz not null default now()
);

create table messages (
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

create table memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  topic text not null,
  summary text not null,
  importance int not null default 3 check (importance between 1 and 5),
  last_accessed timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table agent_logs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  agent text not null,
  input jsonb not null,
  output jsonb,
  latency_ms int,
  model text,
  created_at timestamptz not null default now()
);
```

## RLS Policy Pattern

Enable RLS on every table and scope user-owned records with `auth.uid() = user_id`. The web app writes to `messages` directly using `user_id`. The orchestrator-led flow can additionally group messages with a `conversation_id` for richer multi-thread experiences.
