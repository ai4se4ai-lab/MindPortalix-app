import { createClient } from "@supabase/supabase-js";

let _supabase = null;

function getAdminClient() {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    // Use secret key when available; fall back to publishable key for token validation
    const secretKey = process.env.SUPABASE_SECRET_KEY ?? "";
    const isPlaceholder = !secretKey || secretKey.includes("your-key") || secretKey === "undefined";
    const key = isPlaceholder
      ? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
      : secretKey;
    if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and a Supabase key are required");
    _supabase = createClient(url, key, { auth: { persistSession: false } });
  }
  return _supabase;
}

export async function requireAuth(req, res, next) {
  // Pass-through if upstream middleware (or test harness) already authenticated the request
  if (req.user) { req.token ??= req.headers.authorization?.slice(7) ?? ""; return next(); }

  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing authorization token" });
  }

  try {
    const { data, error } = await getAdminClient().auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    req.user = data.user;
    req.token = token;
    next();
  } catch (err) {
    res.status(500).json({ error: "Auth check failed", detail: err.message });
  }
}

export function optionalAuth(req, res, next) {
  requireAuth(req, res, () => next()).catch(() => next());
}
