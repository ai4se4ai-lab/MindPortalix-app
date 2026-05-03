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
- **Architecture-driven routing** — the user's Mermaid diagram is parsed on every chat request; only agents present in the diagram can run; removing an agent from the diagram immediately removes it from the live pipeline
- **Live context injection** — enabled skill, rule, agent-definition, hook, and MCP files are loaded from disk (with personal-copy override support) and prepended to every agent's system prompt on each request
- **Resource-aware agents** — text files uploaded to `00_Resources/` are automatically included in every agent's workspace context so their content influences responses
- **Context Observatory** — real-time 3-panel monitoring page with per-agent granular highlighting: only the specific skills, rules, and files the active agent uses are lit up; agent nodes are highlighted correctly even when custom node IDs are used (e.g. `plan[Planner]`)
- **Context Feed dock** — resizable bottom panel on the Observatory page showing the live context fed into agents turn-by-turn (MEMORY.md, CLAUDE.md, skill files, resources), with auto-scroll and turn separators
- **Context Monitoring dock** — resizable bottom panel in Chat showing per-agent context state during a live request
- **Two-tier service architecture** — User Level Services (facades that own cache invalidation and broadcast) sit above System Level Services (pure DB access + CO cache-aside layer); chat reads workspace context from CO, never from WS directly
- **WS→CO sync** — every workspace write invalidates the CO cache immediately (direct call + event broadcast), guaranteeing chat always sees fresh context with no stale-read window
- 213 automated tests covering agents, orchestration, architecture enforcement, context injection, resource loading, OpenRouter client, hook safety, workspace isolation, service-layer unit tests, CO sync integration, context-feed broadcasting, bug regressions, and concurrent multi-user correctness (no race conditions, no data bleed across three simultaneous users)

## Architecture

```text
User
  -> PWA Frontend (React 18, SSE stream consumer)
       -> Chat page           (streaming conversation, context monitoring dock)
       -> Workspace page      (agent architecture, context injection, file manager)
       -> Context Observatory (live 3-panel monitor + resizable Context Feed dock)
  -> Express Server
       -> Auth middleware (Supabase JWT)
       -> Intent classifier  ->  Modality detector
       -> Architecture filter  (user's Mermaid diagram gates which agents may run)
       -> CO Service          (cache-aside read; always fresh after any WS write)
       -> Workspace context   (CLAUDE.md + MEMORY.md + resource files + context injection)
       -> Specialist agents   (only those allowed by the architecture, streamed via SSE)
       -> Executor agent      (synthesizes specialist output; skipped if absent from diagram)
       -> Quality review loop (up to 5 retry attempts when Planner is in pipeline)
       -> Memory store        (in-memory or Supabase)
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

### Two-tier service architecture

The server-side code is split into two layers:

| Layer | Location | Responsibility |
| --- | --- | --- |
| **User Level** | `src/services/user/` | Public API facades. Every write calls `invalidateCachedContext(userId)` then broadcasts `ws_write`. Chat reads context through the CO facade. |
| **System Level** | `src/services/system/` | Pure DB access (WS System) and cache-aside context assembly (CO System + CO Context Store). No Express, no HTTP — testable in isolation. |
| **Library** | `src/lib/` | Shared singletons: Supabase client factory with test-injection hooks, and the Default Library (constants used across layers). |

**WS→CO sync rule (Principle 1):** every workspace mutation goes through `ws-service.js`, which synchronously calls `invalidateCachedContext(userId)` before broadcasting the `ws_write` event. The CO cache is therefore always invalidated regardless of whether the event listener was registered at startup.

**Chat reads from CO (Principle 2):** `chat.js` calls `co-service.getContext(sbClient, userId)`, which checks the in-process CO cache first; on a miss it loads from Supabase via `ws-system.dbGetWorkspaceContext`, caches the result, and returns it. The old internal `fetch(http://localhost/api/workspace/context)` loopback has been removed.

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
3. **Keyword scoring** — remaining requests are scored against every agent's keyword list; the top matches become the candidate specialist set.
4. **Architecture filter** — the candidate set is intersected with the agents present in the user's Mermaid diagram. Agents absent from the diagram are excluded regardless of keyword score. If the diagram is blank or unrecognisable, all agents are permitted (default behavior).
5. **Executor** — when two or more text specialists run (or when a Planner is involved), an Executor agent synthesizes their output into a single coherent reply. If Executor is absent from the diagram, each specialist's output is used directly.
6. **Quality loop** — the Reviewer scores the draft; if the score is ≤ 5/10 and a Planner was involved, the pipeline re-runs (up to five attempts) before returning the best result.
7. **Workspace context injection** — on every chat request the server builds a rich context block containing: the user's `CLAUDE.md`, `MEMORY.md`, the content of enabled context-injection items (skills, rules, agent definitions, hooks, MCPs — loaded from disk with personal-copy override), and the text content of files uploaded to `00_Resources/`. This block is prepended to every specialist's system prompt.

## Per-user Workspace

Every authenticated user gets an isolated workspace initialized on first login.

### What each user has

| Item | Description |
| --- | --- |
| `CLAUDE.md` | Personal instructions injected into every agent system prompt |
| `MEMORY.md` | Persistent notes surfaced by the Memory agent |
| `00_Resources/` | Upload area for `.md`, `.pdf`, `.csv`, `.txt` files (max 8 MB each); text files are read by agents on every request |
| Workstations | Named sub-directories, each auto-seeded with their own `CLAUDE.md`, `MEMORY.md`, `00_Resources/` |
| Agent Architecture | Per-user Mermaid diagram **that drives the live pipeline** — saving a new diagram immediately changes which agents run in chat |
| Context Injection | Toggle which skill/agent/rule/MCP/hook/memory categories are active; the content of enabled items is loaded from disk and injected into agents on every request |

### How architecture enforcement works

On every chat request, the server:

1. Loads the user's `mermaidDiagram` from `user_agent_configs`.
2. Parses agent node identifiers from the diagram (`parseArchitectureAgents`). Aliases `imagegen`/`audiogen` resolve to `image_generator`/`audio_generator`. Non-agent tokens (`flowchart`, `userinput`, `response`, etc.) are ignored.
3. Filters the intent-classified route so only diagram-present agents run (`applyArchitectureFilter`).
4. Gates the Executor the same way — if `executor` is absent from the diagram, synthesis is skipped even when multiple specialists ran.

**Example:** remove `planner` from the diagram and save. The next chat request will skip Planner entirely, and the quality retry loop (which requires Planner) will not fire.

### How personalisation works

Context injection items (e.g. `skills/agent-orchestration`) have server-side defaults on disk under `skills/`, `agents/`, `rules/`, `hooks/`, and `mcps/`. When a user edits an item, their version is saved at `_context/{category}/{item}` in `workspace_files` — the server file is never modified. On each chat request, the server checks for a personal copy first and falls back to the disk default if none exists (or if the personal copy is empty). Other users always see the original server default unless they create their own copy.

### Supabase schema

Run `supabase/migrations/20260501000000_workspace_schema.sql` once against your Supabase project to create the three workspace tables. All tables have RLS enabled so users can only read and write their own rows.

```sql
workspace_files        -- file tree (path, content, is_directory)
user_agent_configs     -- mermaid_diagram, agent_overrides (JSONB)
user_context_injection -- rules (JSONB array of category toggles)
```

## Context Observatory

A dedicated monitoring page (`/observatory`) with three resizable panels and a resizable bottom dock:

| Panel / Dock | Shows |
| --- | --- |
| Agent Architecture | Live Mermaid diagram; the active agent node is highlighted during a request |
| Context Injection | Category grid; **only the specific items the active agent uses** are lit — other enabled items stay dim |
| Directory Hierarchy | Auto-expanded workspace file tree; `CLAUDE.md` highlighted while any agent runs (when it has content); `MEMORY.md` highlighted when the Memory agent is active or has content |
| **Context Feed dock** | Resizable bottom panel showing the exact context fed into agents each turn: query, active agents, CLAUDE.md, MEMORY.md, skill files, and resources. Auto-scrolls to the latest entry; each conversation turn ends with a separator line. |

### Per-agent context highlighting

The Observatory uses a static `AGENT_CONTEXT_MAP` to determine which context items each agent directly uses. For example:

- `planner` active → only `agent-orchestration` + `prompt-engineering` glow in Skills; `planner` glows in Agents
- `coder` active → `model-selection` in Skills; `api-design`, `general`, `supabase` in Rules; `coder` in Agents
- `memory` active → `memory` in Agents; `MEMORY.md` in Memory

Items the active agent does not use remain unlit even if their category is enabled.

## Project Structure

```text
app/                 PWA frontend (index.html, manifest, sw.js, icons) + mobile preview
agents/              Agent prompt and contract definitions (Markdown)
commands/            Slash-command documentation
docs/                Architecture, model, data, and test docs
hooks/               Event hook entrypoints
mcps/                MCP connector definitions
rules/               Project conventions (api-design, styling, supabase, testing, general)
skills/              Context packs injected on demand (agent-orchestration, model-selection, …)
src/
  agents/registry.js         Agent definitions and keyword mappings
  hooks/safety.js            Hook safety logic
  lib/
    defaults.js              Default Library — DEFAULT_MERMAID, DEFAULT_CONTEXT_INJECTION, …
    supabase-client.js       Shared Supabase factory with test-injection hooks
  monitor/broadcaster.js     In-process EventEmitter bus (broadcast / subscribe)
  openrouter/                OpenRouter client (text, image, audio)
  orchestration/
    intent.js                Keyword-based intent classifier and modality detector
    architecture.js          Mermaid parser, architecture filter, context injection loader
    orchestrator.js          MindPortalixOrchestrator class
    responses.js             runSpecialistAgent, reviewDraft, parseContent
  server/
    index.js                 Express app entry point — wires up CO cache listener on startup
    middleware/auth.js        Supabase JWT validation
    routes/chat.js           SSE streaming chat — reads context from CO service
    routes/workspace.js      Workspace CRUD — thin HTTP adapter delegating to ws-service / co-service
    routes/conversations.js  Conversation and message persistence
    routes/monitor.js        SSE monitor feed for Context Observatory
  services/
    user/
      ws-service.js          WS User facade — every write invalidates CO cache + broadcasts ws_write
      co-service.js          CO User facade — re-exports getWorkspaceContext for chat layer
    system/
      ws-system.js           WS System — pure Supabase DB access functions (no Express)
      co-system.js           CO System — cache-aside context assembly (miss → DB → cache → return)
      co-context-store.js    CO Cache — module-level Map, TTL, invalidate, ws_write listener
  storage/                   In-memory and Supabase memory stores
supabase/migrations/         Database schema and RLS policies
tests/
  agents/                    Intent routing and reviewer scoring unit tests
  hooks/                     Hook safety unit tests
  services/
    co-context-store.test.js  Cache get/set/invalidate, TTL, ws_write event, multi-user isolation
    co-system.test.js         Cache-miss/hit flow, null client defaults, DB error fallback
    ws-service.test.js        Every write invalidates cache + broadcasts; reads do neither
  integration/
    orchestration.test.js          End-to-end orchestration and memory isolation
    openrouter-client.test.js      OpenRouter request building
    openrouter-stream.test.js      SSE stream parsing
    architecture.test.js           Architecture enforcement, context injection, resource loading
    workspace-isolation.test.js    Workspace isolation + 18 bug regressions
    co-sync.test.js                WS write → CO cache sync: freshness, multi-user isolation, sequential writes
    context-feed.test.js           Context feed broadcaster: payload shapes, turn sequence, ordering
    concurrent-users.test.js       Three simultaneous users: no race conditions, no data bleed
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
| `GET` | `/api/workspace/context` | JWT | Full workspace context for chat injection (includes resource content) |
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

The `workspace_context` event now includes an `architectureAgents` field — the set of agent IDs parsed from the user's diagram — so the client can display which agents are permitted for the current request.

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
npm test                    # all 213 tests
npm run test:agents         # intent routing and reviewer scoring
npm run test:integration    # OpenRouter client, orchestration, architecture, workspace isolation, concurrent users
npm run test:hooks          # hook safety checks
npm run test:concurrent     # concurrent multi-user correctness (race conditions, data isolation)
```

### Test suites

| Suite | Cases | What it covers |
| --- | --- | --- |
| `agents/` | 5 | Intent routing, reviewer scoring, agent registry |
| `hooks/` | 4 | Hook safety checks |
| `services/co-context-store.test.js` | 14 | Cache get/set/invalidate, TTL expiry, `ws_write` event invalidation, multi-user isolation, idempotent init |
| `services/co-system.test.js` | 11 | Cache-miss/hit flow, null client returns defaults, DB error fallback, multi-user isolation |
| `services/ws-service.test.js` | 21 | Every write invalidates CO cache + broadcasts `ws_write`; reads do neither |
| `integration/orchestration.test.js` | 2 | End-to-end orchestration, memory isolation |
| `integration/openrouter-client.test.js` | 1 | OpenRouter request building |
| `integration/openrouter-stream.test.js` | 1 | SSE stream parsing |
| `integration/architecture.test.js` | 43 | Mermaid parsing, architecture filter, context injection content loading, resource inclusion, HTTP-level enforcement |
| `integration/workspace-isolation.test.js` | 44 | Two-user isolation, personalisation, upload, logout/re-login persistence, 18 bug regressions |
| `integration/co-sync.test.js` | 7 | WS write → CO freshness, multi-user isolation, sequential write accumulation |
| `integration/context-feed.test.js` | 18 | Context feed broadcaster payload shapes, turn separators, timestamp ordering |
| `integration/concurrent-users.test.js` | 42 | Three simultaneous users: no race conditions, no data bleed — concurrent init, architecture updates, context injection, resource uploads, write races, personal copy isolation |

The architecture suite (`architecture.test.js`) verifies:

- `parseArchitectureAgents` correctly extracts agent IDs from Mermaid diagrams, resolves aliases, and ignores non-agent tokens
- `applyArchitectureFilter` removes agents absent from the diagram, falls back gracefully, and always preserves the Reviewer
- `buildContextInjectionContent` loads disk files, prefers personal copies, skips disabled categories, and handles missing files without throwing
- `GET /context` returns resource file content (text files up to 8 KB) and the `mermaidDiagram` field
- A pipeline built from a planner-less diagram never routes to Planner

## Documentation

- Agent design: `docs/agent-system/agent-design.md`
- OpenRouter models: `docs/models/openrouter-models.md`
- Supabase schema: `docs/data/supabase-schema.md`
- Test strategy: `docs/testing/test-strategy.md`
- ADR: `docs/adr/0001-free-model-orchestration.md`

## License

MIT License. See `LICENSE`.
