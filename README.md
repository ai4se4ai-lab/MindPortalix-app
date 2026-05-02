# MindPortalix

> Intelligence, orchestrated. Performance without the price tag.

MindPortalix is an AI assistant platform that delivers GPT-4-class product behavior by orchestrating specialized agents on free OpenRouter models. Memory, review, routing, governance, and formatting are explicit system components — not hidden work inside one expensive model.

## What Is Implemented

- Full-stack Express server (`src/server/`) with SSE streaming chat
- React PWA frontend in `app/web/` (installable, service-worker enabled)
- Mobile UX preview in `app/mobile/`
- 12-agent registry with intent routing, modality detection, and quality review loop
- In-memory and Supabase-backed memory stores
- OpenRouter client supporting text, image, and audio generation
- Supabase authentication, conversation persistence, and RLS policies
- **Per-user workspace** — agent architecture editor, context injection toggles, personal file hierarchy, and workstation directories; each user's data is fully isolated via RLS
- **Context Observatory** — real-time 3-panel monitoring page showing the live agent diagram, active context injection categories, and workspace directory hierarchy
- **Context Monitoring dock** — resizable bottom panel in Chat showing per-agent context state during a live request
- 59 automated tests covering agents, orchestration, OpenRouter client, hook safety, workspace isolation, and bug regressions

## Architecture

```text
User
  -> PWA Frontend (React 18, SSE stream consumer)
       -> Chat page          (streaming conversation, context monitoring dock)
       -> Workspace page     (agent architecture, context injection, file manager)
       -> Context Observatory (live 3-panel agent/context/directory monitor)
  -> Express Server
       -> Auth middleware (Supabase JWT)
       -> Intent classifier  ->  Modality detector
       -> Workspace context  (CLAUDE.md + MEMORY.md injected into every agent)
       -> Specialist agents  (parallel, streamed via SSE)
       -> Executor agent     (synthesizes specialist output)
       -> Quality review loop (up to 5 retry attempts)
       -> Memory store       (in-memory or Supabase)
  -> OpenRouter API
       -> Free text models
       -> Image generation (FLUX)
       -> Audio / music generation (Lyria)
  -> Supabase
       -> Auth (JWT, magic link, email/password)
       -> workspace_files        (per-user file tree)
       -> user_agent_configs     (per-user Mermaid diagram + agent overrides)
       -> user_context_injection (per-user context category toggles)
       -> conversations + messages
       -> memory_entries
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
6. **Workspace context injection** — on every chat request the server loads the user's `CLAUDE.md` and `MEMORY.md` and prepends them to every specialist's system prompt.

## Per-user Workspace

Every authenticated user gets an isolated workspace initialized on first login.

### What each user has

| Item | Description |
| --- | --- |
| `CLAUDE.md` | Personal instructions injected into every agent system prompt |
| `MEMORY.md` | Persistent notes surface by the Memory agent |
| `00_Resources/` | Upload area for `.md`, `.pdf`, `.csv`, `.txt` files (max 8 MB each) |
| Workstations | Named sub-directories, each auto-seeded with their own `CLAUDE.md`, `MEMORY.md`, `00_Resources/` |
| Agent Architecture | Per-user Mermaid diagram defining the agent graph; editable with live preview |
| Context Injection | Toggle which skill/agent/rule/MCP/hook/memory categories are active; click any item to read or personalise its definition |

### How personalisation works

Context injection items (e.g. `skills/agent-orchestration`) have server-side defaults stored on disk under `skills/`, `agents/`, `rules/`, `hooks/`, and `mcps/`. When a user edits an item, their version is saved at `_context/{category}/{item}` in `workspace_files` — the server file is never modified. Other users always see the original server default unless they create their own copy.

### Supabase schema

Run `supabase/migrations/20260501000000_workspace_schema.sql` once against your Supabase project to create the three workspace tables. All tables have RLS enabled so users can only read and write their own rows.

```sql
workspace_files        -- file tree (path, content, is_directory)
user_agent_configs     -- mermaid_diagram, agent_overrides (JSONB)
user_context_injection -- rules (JSONB array of category toggles)
```

## Context Observatory

A dedicated monitoring page (`/observatory`) with three resizable panels:

| Panel | Shows |
| --- | --- |
| Agent Architecture | Live Mermaid diagram; active agent highlighted during a request |
| Context Injection | Category grid; categories light up as they are injected for the current agent |
| Directory Hierarchy | Expandable workspace file tree; `CLAUDE.md` and `MEMORY.md` highlighted when loaded |

## Project Structure

```text
app/                 PWA frontend (index.html, manifest, sw.js, icons) + mobile preview
agents/              Agent prompt and contract definitions (Markdown)
commands/            Slash-command documentation
docs/                Architecture, model, data, and test docs
hooks/               Event hook entrypoints
rules/               Project conventions (api-design, styling, supabase, testing, general)
skills/              Context packs injected on demand (agent-orchestration, model-selection, …)
src/
  agents/registry.js       Agent definitions and keyword mappings
  hooks/safety.js          Hook safety logic
  openrouter/              OpenRouter client (text, image, audio)
  orchestration/           Intent classifier, modality detector, orchestrator, responses
  server/
    index.js               Express app entry point
    middleware/auth.js      Supabase JWT validation
    routes/chat.js         SSE streaming chat (injects workspace context on every request)
    routes/workspace.js    Workspace CRUD — files, agent config, context injection, defaults
    routes/conversations.js Conversation and message persistence
    routes/monitor.js      SSE monitor feed for Context Observatory
  storage/                 In-memory and Supabase memory stores
supabase/migrations/       Database schema and RLS policies
tests/
  agents/                  Intent routing and reviewer scoring unit tests
  hooks/                   Hook safety unit tests
  integration/
    orchestration.test.js          End-to-end orchestration and memory isolation
    openrouter-client.test.js      OpenRouter request building
    openrouter-stream.test.js      SSE stream parsing
    workspace-isolation.test.js    26 workspace isolation cases + 18 bug regressions
```

## API Endpoints

### Core

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

### Workspace

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/workspace/init` | JWT | Idempotent workspace bootstrap (first login) |
| `GET` | `/api/workspace/context` | JWT | Full workspace context for chat injection |
| `GET` | `/api/workspace/agent-config` | JWT | User's Mermaid diagram and agent overrides |
| `PUT` | `/api/workspace/agent-config` | JWT | Save diagram / overrides |
| `GET` | `/api/workspace/context-injection` | JWT | User's category toggle rules |
| `PUT` | `/api/workspace/context-injection` | JWT | Save category rules |
| `GET` | `/api/workspace/files` | JWT | List workspace files (excludes `_context/`) |
| `GET` | `/api/workspace/files/*` | JWT | Read a single file |
| `PUT` | `/api/workspace/files/*` | JWT | Create or update a file |
| `DELETE` | `/api/workspace/files/*` | JWT | Delete a file or directory (cascade) |
| `POST` | `/api/workspace/upload` | JWT | Upload `.md/.pdf/.csv/.txt` into `00_Resources/` |
| `POST` | `/api/workspace/directories` | JWT | Create workstation (auto-seeds defaults, idempotent) |
| `GET` | `/api/workspace/defaults/:ruleId/:item` | JWT | Read server-side default for a context item |

The `/api/chat` endpoint uses **Server-Sent Events**. Events emitted during a request:
`phase`, `route`, `pipeline`, `conversation`, `workspace_context`, `agent_start`, `agent_output_delta`, `agent_output_reset`, `agent_done`, `agent_detail`, `media`, `delta`, `delta_reset`, `thinking`, `review`, `done`, `error`.

## Getting Started

**Requirements:** Node.js ≥ 18, an [OpenRouter](https://openrouter.ai) API key, and (optionally) a [Supabase](https://supabase.com) project.

```bash
npm install
cp .env.example .env.local
# edit .env.local with your credentials
npm start          # production server on http://localhost:3000
npm run dev        # file-watch dev server
```

Open `http://localhost:3000` in a browser. Sign in with the Supabase magic-link or email/password form, or explore the chat UI directly without auth (in-memory mode).

**With Supabase:** run the workspace migration once:

```bash
# In the Supabase SQL editor, paste and run:
supabase/migrations/20260501000000_workspace_schema.sql
```

After signing in, the workspace is initialized automatically on first visit.

## Environment Variables

Copy `.env.example` to `.env.local` and fill in your credentials.

| Variable | Required | Description |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key |
| `NEXT_PUBLIC_SUPABASE_URL` | No | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | No | Supabase publishable (anon) key |
| `SUPABASE_SECRET_KEY` | No | Supabase secret key (server-only, enables RLS bypass for admin ops) |
| `OPENROUTER_BASE_URL` | No | OpenRouter base URL (default: `https://openrouter.ai/api/v1`) |
| `APP_ENV` | No | `development` or `production` |
| `APP_URL` | No | App URL used in OpenRouter `HTTP-Referer` header |
| `PORT` | No | Server port (default: `3000`) |
| `ENABLE_REVIEWER` | No | Enable reviewer quality gate (default: `true`) |
| `ENABLE_MEMORY` | No | Enable memory store (default: `true`) |
| `ENABLE_PAID_MODELS` | No | Allow paid OpenRouter models (default: `false`) |

Without Supabase configured, the server runs with an in-memory store — no auth, no persistence, no workspace.

## Testing

```bash
npm test                    # all 59 tests
npm run test:agents         # intent routing and reviewer scoring
npm run test:integration    # OpenRouter client, orchestration, workspace isolation
npm run test:hooks          # hook safety checks
```

The workspace isolation suite (`tests/integration/workspace-isolation.test.js`) spins up two in-memory Express servers (Alice and Bob) backed by an in-memory Supabase mock and verifies complete data isolation across agent architecture, context injection, file content, directory hierarchy, context item personalisation, upload, and logout/re-login persistence. It also includes 18 regression cases covering the three bugs fixed after initial deployment:

- `_context/` virtual entries must never appear in `GET /files` or the directory hierarchy
- Empty personal copies (created by an old premature auto-save) must fall through to the server-side default
- Workstation entry (`POST /directories`) must be idempotent and always seed `CLAUDE.md`, `MEMORY.md`, `00_Resources/`

## Documentation

- Agent design: `docs/agent-system/agent-design.md`
- OpenRouter models: `docs/models/openrouter-models.md`
- Supabase schema: `docs/data/supabase-schema.md`
- Test strategy: `docs/testing/test-strategy.md`
- ADR: `docs/adr/0001-free-model-orchestration.md`

## License

MIT License. See `LICENSE`.
