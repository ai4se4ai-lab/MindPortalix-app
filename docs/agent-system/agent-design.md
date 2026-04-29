# Agent Design

MindPortalix uses explicit specialist agents to approximate frontier-model behavior with smaller free OpenRouter models.

## Flow

1. The orchestrator classifies intent.
2. The memory store retrieves relevant user context.
3. Specialist agents produce narrow outputs.
4. The reviewer scores the synthesis.
5. Durable context is compressed back into memory.

## Agent Contracts

Every agent definition includes purpose, model, responsibilities, inputs, output contract, and escalation rules. The runtime registry in `src/agents/registry.js` is the source of truth used by tests and orchestration.
