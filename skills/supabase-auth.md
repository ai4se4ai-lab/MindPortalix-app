# Supabase Auth Skill

Use Supabase Auth for email/password and magic link flows. Browser clients use only the publishable key (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`). Edge functions use the secret key (`SUPABASE_SECRET_KEY`) for trusted server-side orchestration.

Always verify that user-owned reads and writes are scoped to the authenticated user.
