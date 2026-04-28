# API Design Rules

- Keep OpenRouter calls behind a small client wrapper.
- Time out external model calls and return structured errors.
- Never send service role keys to browser code.
- Include model, agent, latency, and score in agent logs.
- Make streaming optional so tests can use deterministic non-streaming responses.
