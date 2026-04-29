# ADR 0001: Free Model Orchestration

## Status
Accepted

## Context
MindPortalix aims to deliver strong assistant behavior without depending on expensive frontier models for every request.

## Decision
Use explicit specialist agents backed by free OpenRouter models. Route requests through memory retrieval, task-specific specialists, and reviewer validation.

## Consequences
- Lower marginal model cost for MVP usage.
- More inspectable behavior because routing and review are logged.
- More engineering responsibility in orchestration, testing, and observability.
