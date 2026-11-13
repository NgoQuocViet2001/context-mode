// impl/01 §1, impl/00 §3.1, docs/architecture/PRD.md §3. D-FX-MCP-1 appends fx to the existing order. Data only.
export const AGENT_IDS = ["claude-code","codex","gemini","qwen","copilot-cli","vscode","kiro","zcode","pi","opencode","fx"] as const; // TECH-SPEC §2
export type AgentId = typeof AGENT_IDS[number];
