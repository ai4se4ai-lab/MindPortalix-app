/**
 * Shared Supabase client factory.
 * Single source of truth — both workspace routes and CO system use this.
 * Test injection (setClientFactory) covers all callers automatically.
 */
import { createClient } from "@supabase/supabase-js";

function isSecretPlaceholder(v) {
  return !v || v.includes("your-key") || v === "undefined";
}

let _factory = null;

export function setClientFactory(fn) { _factory = fn; }
export function resetClientFactory()  { _factory = null; }

export function getClient(accessToken) {
  if (_factory) return _factory(accessToken);

  const url    = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY ?? "";
  const usingPublishable = isSecretPlaceholder(secret);
  const key = usingPublishable
    ? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    : secret;
  if (!url || !key) return null;

  const opts = { auth: { persistSession: false } };
  if (usingPublishable && accessToken) {
    opts.global = { headers: { Authorization: `Bearer ${accessToken}` } };
  }
  return createClient(url, key, opts);
}
