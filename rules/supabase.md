# Supabase Rules

- Enable RLS on all user-owned tables.
- Scope policies with `auth.uid() = user_id`.
- Store user content in `messages` and durable summaries in `memories`.
- Use service role keys only in trusted edge functions.
- Add migrations and documentation together for schema changes.
