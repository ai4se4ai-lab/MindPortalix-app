# MindPortalix

> Intelligence, orchestrated. Performance without the price tag.

MindPortalix is an AI assistant platform that delivers GPT-4-class product behavior by orchestrating specialized agents on free OpenRouter models. Memory, review, routing, governance, and formatting are explicit system components — not hidden work inside one expensive model.

## What Is Implemented

- Full-stack Express server (`src/server/`) with SSE streaming chat
- React PWA frontend in `app/web/` (installable, service-worker enabled)
- Mobile UX preview in `app/mobile/`
- 11-agent registry with intent routing, modality detection, and quality review loop
- In-memory and Supabase-backed memory stores
- OpenRouter client supporting text, image, and audio generation
- Supabase authentication, conversation persistence, and RLS policies
- Automated tests under `tests/agents`, `tests/integration`, and `tests/hooks`

## Architecture

```text
User
  -> PWA Frontend (React 18, SSE stream consumer)
  -> Express Server
       -> Auth middleware (Supabase JWT)
       -> Intent classifier  →  Modality detector
       -> Specialist agents  (parallel, streamed via SSE)
       -> Executor agent     (synthesizes specialist output)
       -> Quality review loop (up to 5 retry attempts)
       -> Memory store       (in-memory or Supabase)
  -> OpenRouter API
       -> Free text models
       -> Image generation (FLUX)
       -> Audio / music generation (Lyria)
```

## Agent System

| Agent | Role | Model |
| --- | --- | --- |
| Orchestrator | Classifies intent and coordinates specialists | `mistralai/mistral-7b-instruct` |
| Researcher | Retrieval, source ranking, fact synthesis | `google/gemma-3-8b-it` |
| Reviewer | Quality score and retry gate | `qwen/qwen-2.5-7b-instruct` |
| Memory | Durable user context | `meta-llama/llama-3.1-8b-instruct` |
| Coder | Implementation and debugging | `microsoft/phi-3-mini-128k-instruct` |
| Writer | Long-form writing and summaries | `google/gemma-3-8b-it` |
| Governor | Safety, privacy, policy checks | `qwen/qwen-2.5-7b-instruct` |
| Planner | Multi-step task decomposition | `mistralai/mistral-7b-instruct` |
| Executor | Synthesizes specialist output into a single reply | `google/gemma-3-8b-it` |
| Image Generator | Text-to-image via FLUX | `black-forest-labs/flux-1-schnell:free` |
| Audio Generator | Music / TTS via Lyria | `google/lyria-3-pro-preview` |
| Formatter | Markdown, JSON, tables, final rendering | `microsoft/phi-3-mini-128k-instruct` |

### How routing works

1. **Modality detection** — if the request clearly needs image or audio output, it routes directly to the relevant media agent; no text specialists are invoked.
2. **Conversational shortcut** — simple greetings and acknowledgements route to Writer only.
3. **Keyword scoring** — remaining requests are scored against every agent's keyword list; the top matches become the active specialist set.
4. **Executor** — when two or more text specialists run (or when a Planner is involved), an Executor agent synthesizes their output into a single coherent reply.
5. **Quality loop** — the Reviewer scores the draft; if the score is ≤ 5/10 and a Planner was involved, the pipeline re-runs (up to five attempts) before returning the best result.

## Project Structure

```text
app/                 PWA frontend (index.html, manifest, sw.js, icons) + mobile preview
agents/              Agent prompt and contract definitions (Markdown)
commands/            Slash-command documentation
docs/                Architecture, model, data, and test docs
hooks/               Event hook entrypoints
rules/               Project conventions
skills/              Context packs loaded on demand
src/
  agents/registry.js    Agent definitions and keyword mappings
  hooks/safety.js       Hook safety logic
  openrouter/           OpenRouter client (text, image, audio)
  orchestration/        Intent classifier, modality detector, orchestrator, responses
  server/               Express app, routes (/api/chat, /api/conversations), auth middleware
  storage/              In-memory and Supabase memory stores
supabase/migrations/    Database schema and RLS policies
tests/                  Automated tests and fixtures
```

## API Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | Server health and version |
| `GET` | `/api/config` | — | Supabase public config for the client |
| `POST` | `/api/chat` | JWT | SSE streaming chat |
| `GET` | `/api/chat/agents` | — | List all registered agents |
| `GET` | `/api/chat/models` | — | List free OpenRouter models |
| `GET` | `/api/conversations` | JWT | List user's conversations |
| `POST` | `/api/conversations` | JWT | Create a conversation |
| `GET` | `/api/conversations/:id/messages` | JWT | Fetch messages in a conversation |
| `DELETE` | `/api/conversations/:id` | JWT | Delete a conversation |

The `/api/chat` endpoint uses **Server-Sent Events**. Events emitted during a request: `phase`, `route`, `pipeline`, `conversation`, `agent_start`, `agent_output_delta`, `agent_output_reset`, `agent_done`, `agent_detail`, `media`, `delta`, `delta_reset`, `thinking`, `review`, `done`, `error`.

## Getting Started

**Requirements:** Node.js ≥ 18, an [OpenRouter](https://openrouter.ai) API key, and (optionally) a [Supabase](https://supabase.com) project.

```bash
npm install
cp .env.example .env.local
npm start          # production server on http://localhost:3000
npm run dev        # file-watch dev server
```

Open `http://localhost:3000` in a browser. Sign in with the Supabase magic-link or email/password form (requires Supabase to be configured) or explore the chat UI directly.

## Environment Variables

Copy `.env.example` to `.env.local` and fill in your credentials.

| Variable | Required | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | No | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | No | Supabase publishable (anon) key |
| `SUPABASE_SECRET_KEY` | No | Supabase secret key (server-only) |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key |
| `OPENROUTER_BASE_URL` | No | OpenRouter base URL (default: `https://openrouter.ai/api/v1`) |
| `APP_ENV` | No | `development` or `production` |
| `APP_URL` | No | App URL used in OpenRouter `HTTP-Referer` header |
| `PORT` | No | Server port (default: `3000`) |
| `ENABLE_REVIEWER` | No | Enable reviewer quality gate (default: `true`) |
| `ENABLE_MEMORY` | No | Enable memory store (default: `true`) |
| `ENABLE_PAID_MODELS` | No | Allow paid OpenRouter models (default: `false`) |

Without Supabase configured, the server runs with an in-memory store (no auth, no persistence).

## Testing

```bash
npm test                   # all tests
npm run test:agents        # intent and reviewer unit tests
npm run test:integration   # OpenRouter client and orchestration tests
npm run test:hooks         # hook safety tests
```

## Documentation

- Agent design: `docs/agent-system/agent-design.md`
- OpenRouter models: `docs/models/openrouter-models.md`
- Supabase schema: `docs/data/supabase-schema.md`
- Test strategy: `docs/testing/test-strategy.md`
- ADR: `docs/adr/0001-free-model-orchestration.md`

## License

MIT License. See `LICENSE`.
