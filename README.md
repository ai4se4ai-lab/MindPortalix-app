# MindPortalix

> Intelligence, orchestrated. Performance without the price tag.

MindPortalix is an AI assistant platform that simulates GPT-4-class product behavior by orchestrating specialized agents on free OpenRouter models. Memory, review, routing, governance, and formatting are explicit system components instead of hidden work inside one expensive model.

## What Is Implemented

- Static web chat demo in `app/web/MindPortalix.html`
- Mobile UX preview in `app/mobile/MindPortalix Mobile Preview.html`
- Agent definitions in `agents/`
- Runtime agent registry and orchestrator in `src/`
- Memory store, reviewer scoring, OpenRouter request builder, and hook safety logic
- Supabase schema migration with RLS policies in `supabase/migrations/`
- Rules, skills, slash-command docs, architecture docs, and ADRs
- Automated tests under `tests/agents`, `tests/integration`, and `tests/hooks`

## Architecture

```text
User
  -> Frontend App
  -> Supabase Auth / DB / Realtime
  -> Orchestrator
  -> Memory + Specialists + Reviewer
  -> OpenRouter free models
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
| Formatter | Markdown, JSON, tables, final rendering | `microsoft/phi-3-mini-128k-instruct` |

## Project Structure

```text
app/                 Static web and mobile previews
agents/              Agent prompt and contract definitions
commands/            Slash-command documentation
docs/                Architecture, model, data, and test docs
hooks/               Event hook entrypoints
rules/               Project conventions
skills/              Context packs loaded on demand
src/                 Runtime orchestration code
supabase/migrations/ Database schema and RLS
tests/               Automated tests and fixtures
```

## Getting Started

```bash
npm install
cp .env.example .env.local
npm test
```

Open `app/web/MindPortalix.html` directly in a browser for the local static demo.

## Environment Variables

See `.env.example` for Supabase, OpenRouter, app URL, and feature flag settings.

## Testing

```bash
npm test
npm run test:agents
npm run test:integration
npm run test:hooks
```

## Documentation

- Agent design: `docs/agent-system/agent-design.md`
- OpenRouter models: `docs/models/openrouter-models.md`
- Supabase schema: `docs/data/supabase-schema.md`
- Test strategy: `docs/testing/test-strategy.md`
- ADR: `docs/adr/0001-free-model-orchestration.md`

## License

MIT License. See `LICENSE`.
