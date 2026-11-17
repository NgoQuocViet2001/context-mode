// impl/01 §1, impl/00 §3.1, docs/architecture/PRD.md §3 (agent table, top to bottom; omp: ADR-0026; fx: ADR-0027, proposed). Data only.
export const AGENT_IDS = ["claude-code","codex","gemini","qwen","copilot-cli","vscode","kiro","zcode","pi","opencode","omp","fx"] as const; // TECH-SPEC §2; omp is the 11th; fx follows as the proposed MCP client
export type AgentId = typeof AGENT_IDS[number];
