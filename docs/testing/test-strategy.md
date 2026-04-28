# Test Strategy

The MVP test suite uses Node's built-in test runner to avoid dependency setup.

## Coverage Areas

- Agent registry and intent classification
- End-to-end orchestration with memory write-back
- Hook safety checks and memory sanitization
- OpenRouter request construction without making network calls

## Commands

```bash
npm test
npm run test:agents
npm run test:integration
npm run test:hooks
```
