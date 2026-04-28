export function postToolUse(event) {
  const touchedDatabase = event?.files?.some((file) => /supabase|migration|schema/i.test(file));
  return {
    logged: true,
    reminder: touchedDatabase ? "Database changes require matching RLS policy review." : null
  };
}
