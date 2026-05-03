/**
 * System-level defaults — source of truth for the Default Library.
 * Every new user's workspace is seeded from these values.
 * Re-exported from workspace.js for backward compatibility with tests.
 */

export const DEFAULT_MERMAID = `flowchart TD
  userinput([User Input]) --> orchestrator
  orchestrator --> researcher
  orchestrator --> memory
  orchestrator --> coder
  orchestrator --> writer
  orchestrator --> governor
  orchestrator --> planner
  orchestrator --> formatter
  orchestrator --> imagegen["Image Gen"]
  orchestrator --> audiogen["Audio Gen"]
  researcher --> executor
  memory --> executor
  coder --> executor
  writer --> executor
  planner --> executor
  formatter --> executor
  executor --> reviewer
  reviewer --> response([Response])`;

export const DEFAULT_CONTEXT_INJECTION = [
  { id: "skills",  label: "Skills",  items: ["agent-orchestration","memory-compression","model-selection","openrouter","prompt-engineering","supabase-auth"], active: true },
  { id: "agents",  label: "Agents",  items: ["orchestrator","researcher","reviewer","memory","coder","writer","governor","planner","executor","formatter","image_generator","audio_generator"], active: true },
  { id: "rules",   label: "Rules",   items: ["api-design","general","styling","supabase","testing"], active: true },
  { id: "mcps",    label: "MCPs",    items: ["github","supabase"], active: true },
  { id: "hooks",   label: "Hooks",   items: ["on-agent-complete","on-error","on-memory-write","post-tool-use","pre-tool-use"], active: true },
  { id: "memory",  label: "Memory",  items: ["MEMORY.md"], active: true },
];

export const DEFAULT_CLAUDE_MD = `# My Workspace

This is your personal MindPortalix workspace. Add context and instructions for the AI agents here.

## Instructions
- Add your preferences, goals, and important context here
- Reference files in 00_Resources/ for the agents to use
- Create workstations (directories) for different projects

## Preferences
- (Add your preferences here)
`;

export const DEFAULT_MEMORY_MD = `# Memory

This file stores important context about your preferences, ongoing projects, and key information.

## About Me
- (Add information about yourself here)

## Active Projects
- (Add your current projects here)

## Key Notes
- (Add important notes here)
`;
