import { ADAPTERS } from "../../src/adapters/table.ts";

// ADR-0020's accepted hook hosts, pinned by id: a test that runs over them fails when one of them loses its row,
// instead of quietly running over fewer hosts.
export const HOOK_HOST_IDS = Object.freeze([
  "claude-code", "codex", "gemini", "qwen", "copilot-cli",
  "vscode", "kiro", "zcode", "pi", "opencode",
]);

/** The adapter rows of the ten hook hosts, in this order. */
export function hookHostRows() {
  return HOOK_HOST_IDS.map((id) => {
    const row = ADAPTERS.find((r) => r.id === id);
    if (row === undefined) throw new Error(`${id} has no adapter row`);
    return row;
  });
}
