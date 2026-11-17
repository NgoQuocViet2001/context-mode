// Vercel Labs fx (D-FX-MCP-1, proposed): stdio MCP and skills, no hook channel. fx defines PreToolUse and takes its
// handlers only from code compiled into fx (only fx's own tests register one at v0.0.16), and its observer hooks need an
// embedding host. Sources at fx v0.0.16: src/core/hooks/definitions.zig, src/core/hooks/runtime.zig (registerPreToolUse),
// sdk/semantic-observer-hooks.md ("The standalone CLI doesn't install an observer sink"),
// src/core/mcp/tool_names.zig (mcp_<server>_<tool>) and src/builtins/tools.zig (shell, read_file, grep_files).
import { HOOK_UNAVAILABLE_DETAIL } from "../core/contracts/constants.ts";
import type { CanonicalHookEvent, Decision, HookOutput } from "../core/contracts/types.ts";

export const TOOL_NAME_PREFIX = "mcp_context-mode_";
const HOOK_LIMITATION = HOOK_UNAVAILABLE_DETAIL("fx");

export function decode(_raw: unknown): CanonicalHookEvent {
  throw new Error(HOOK_LIMITATION);
}
export function encode(_ev: CanonicalHookEvent, _decision: Decision): HookOutput {
  throw new Error(HOOK_LIMITATION);
}
