# `/new-agent <name>`

Scaffold a new file under `agents/<name>.md` with these sections:

- Purpose
- Model
- Responsibilities
- Inputs
- Output Contract
- Escalation

Then add the agent to `src/agents/registry.js` and cover routing with a test under `tests/agents`.
