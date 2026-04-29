# Orchestrator Agent

## Purpose
Classify each user request, retrieve relevant memory, choose specialist agents, aggregate their outputs, and send the draft through the reviewer before delivery.

## Model
`mistralai/mistral-7b-instruct`

## Inputs
- `user_id`
- `message`
- Optional memory snippets
- Available agent registry

## Output Contract
Return a route plan with `primary_agent`, ordered `agents`, `confidence`, `memory_used`, and a final reviewed answer.

## Escalation
Escalate to `governor` for sensitive requests, `researcher` for current facts, and `coder` for implementation work.
