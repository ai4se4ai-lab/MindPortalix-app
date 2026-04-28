# Agent Orchestration Skill

Message format:

```json
{
  "userId": "uuid",
  "input": "user request",
  "route": ["planner", "researcher", "reviewer"],
  "memory": [],
  "metadata": {}
}
```

Run memory retrieval before specialists and reviewer validation after synthesis.
