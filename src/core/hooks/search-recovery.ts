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
  const recovery = recoveryArgs(project, sourceId, env, tool, terms);
  return recovery === null ? null : (recovery.powershell ? "& " : "")
    + recovery.args.map((v) => shellQuote(v, recovery.powershell)).join(" ");
}

function recoveryArgs(project: ProjectContext, sourceId: number, env: NodeJS.ProcessEnv, tool: string, terms: string): { args: string[]; powershell: boolean } | null {
  if (!Number.isSafeInteger(sourceId) || sourceId < 0) return null;
  const bundle = env.CLAUDE_PLUGIN_ROOT || dirname(process.argv[1] ?? "");
  const search = join(bundle, SEARCH_WRAPPER_FILE);
  try { if (!lstatSync(search).isFile()) return null; } catch { return null; }
  const powershell = tool === "PowerShell" || (tool !== "Bash" && env.CLAUDE_CODE_USE_POWERSHELL_TOOL === "1");
  const native = (path: string): string => process.platform === "win32" && !powershell ? path.split("\\").join("/") : path;
  const binding = Buffer.from(JSON.stringify({ worktree: project.worktree, dataDir: dirname(dirname(project.projectDir)) })).toString("base64url");
  // The empty query reads the first page; replace it with words from the output to find another part.
  // Every external argument is a single shell literal, including paths containing quotes, $, ` or &.
  return { args: [native(process.execPath), native(search), String(sourceId), terms, "--context", binding], powershell };
}

// Parse only the literal argument syntax emitted above, plus simple unquoted words when the model
// fills in a query or numeric ID. No expansions, double quotes, redirects, pipelines or statements.
function literalArgs(command: string, powershell: boolean): string[] | null {
  let rest = command.trim();
  if (powershell) {
    if (!rest.startsWith("& ")) return null;
    rest = rest.slice(2).trimStart();
  }
  const args: string[] = [];
  let i = 0;
  while (i < rest.length) {
    let word = "";
    let quoted = false;
    let started = false;
    while (i < rest.length) {
      const c = rest[i];
      if (c === "'") {
        started = true;
        if (powershell && quoted && rest[i + 1] === "'") { word += "'"; i += 2; continue; }
        quoted = !quoted;
        i++;
      } else if (!powershell && !quoted && c === "\\" && rest[i + 1] === "'") {
        word += "'"; started = true; i += 2;
      } else if (!quoted && c === " ") break;
      else {
        if (!quoted && !"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./:=-".includes(c)) return null;
        word += c; started = true; i++;
      }
    }
    if (quoted || !started) return null;
    args.push(word);
    if (args.length > 6) return null;
    while (rest[i] === " ") i++;
  }
  return args;
}

/** Exact generated executable, wrapper, source, project/store binding and literal query only. */
export function isLocalSearchRecovery(command: string, project: ProjectContext, env: NodeJS.ProcessEnv, tool: string): boolean {
  const powershell = tool === "PowerShell" || (tool !== "Bash" && env.CLAUDE_CODE_USE_POWERSHELL_TOOL === "1");
  const args = literalArgs(command, powershell);
  if (args === null || args.length !== 6) return false;
  const id = Number(args[2]);
  const expected = recoveryArgs(project, id, env, tool, args[3]);
  return expected !== null && args.every((arg, i) => arg === expected.args[i]);
}
