// A hook replacement must remain readable when Claude never starts the plugin MCP server.
// This command uses the shipped search wrapper, not an inferred server or credential/config path.
const { lstatSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
import { dirname, join } from "node:path";
import type { ProjectContext } from "../contracts/types.ts";
import { SEARCH_WRAPPER_FILE } from "../contracts/constants.ts";

export function shellQuote(value: string, powershell: boolean): string {
  return "'" + value.split("'").join(powershell ? "''" : "'\\''") + "'";
}

export function localSearchCommand(project: ProjectContext, sourceId: number, env: NodeJS.ProcessEnv, tool: string, terms = ""): string | null {
  if (!Number.isSafeInteger(sourceId) || sourceId < 0) return null;
  const bundle = env.CLAUDE_PLUGIN_ROOT || dirname(process.argv[1] ?? "");
  const search = join(bundle, SEARCH_WRAPPER_FILE);
  try { if (!lstatSync(search).isFile()) return null; } catch { return null; }
  const powershell = tool === "PowerShell" || env.CLAUDE_CODE_USE_POWERSHELL_TOOL === "1";
  const native = (path: string): string => process.platform === "win32" && !powershell ? path.split("\\").join("/") : path;
  const binding = Buffer.from(JSON.stringify({ worktree: project.worktree, dataDir: dirname(dirname(project.projectDir)) })).toString("base64url");
  // The empty query reads the first page; replace it with words from the output to find another part.
  // Every external argument is a single shell literal, including paths containing quotes, $, ` or &.
  return (powershell ? "& " : "") + [native(process.execPath), native(search), String(sourceId), terms, "--context", binding]
    .map((v) => shellQuote(v, powershell)).join(" ");
}
