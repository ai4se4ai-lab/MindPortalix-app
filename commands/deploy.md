# `/deploy`

Before deployment:

1. Run `npm test`.
2. Verify required environment variables are configured.
3. Confirm Supabase migrations have been applied.
4. Deploy web assets to Vercel.
5. Deploy Supabase edge functions.

Manual command:

```bash
vercel --prod
```
