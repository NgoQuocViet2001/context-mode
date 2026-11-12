// Vercel Labs fx: stdio MCP and skills. Its hook API is in-process (libfx),
// not an external command-hook channel configurable by the fx CLI.
// Source: vercel-labs/fx src/core/mcp/tool_names.zig, shared/types.zig,
// core/hooks/definitions.zig and core/config/settings_keys.zig.
import type { CanonicalHookEvent, Decision, HookOutput } from "../core/contracts/types.ts";

export const TOOL_NAME_PREFIX = "mcp_context-mode_";
export const HOOK_LIMITATION = "fx CLI has no external command-hook channel; native tool interception and automatic session continuity are unavailable. Use the ctx MCP tools explicitly.";

export function decode(_raw: unknown): CanonicalHookEvent {
  throw new Error(HOOK_LIMITATION);
}
export function encode(_ev: CanonicalHookEvent, _decision: Decision): HookOutput {
  throw new Error(HOOK_LIMITATION);
}
