// D-FX-MCP-1: fx owns its MCP schema. Its list command validates the effective configuration without
// connecting to any server; checking the exit code alone misses entries fx skips with only a note on stderr.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  FX_CONFIG_LIST_FAILED, FX_CONFIG_LIST_INVALID, FX_CONFIG_MAX_BYTES, FX_CONFIG_REJECTED, FX_CONFIG_TIMEOUT_MS, FX_LIST_FIX, FX_START_FIX,
  FX_HELP_PREFIX, FX_LIST_IDLE, FX_LIST_SOURCE, FX_LIST_TRANSPORT, FX_MCP_NOT_READY, FX_MCP_RESULT_INVALID,
  FX_MCP_START_FAILED, FX_NOT_AGENT, FX_PATH_UNAVAILABLE, FX_PROFILE_FIX, FX_SHOW_READY, FX_SHOW_TIMEOUT_MS, SERVER_KEY,
} from "../contracts/constants.ts";
import { spawnShim, whichBin } from "../../setup/spawn-bin.ts";

// `fix`: the Fix: line for a failed check; fx output is never echoed (a command it prints can hold expanded ${VAR} values).
export interface FxConfigCheck { ok: boolean; warn?: boolean; detail?: string; fix?: string; }

const limits = { encoding: "utf8" as const, timeout: FX_CONFIG_TIMEOUT_MS, maxBuffer: FX_CONFIG_MAX_BYTES };

/** Vercel's agent and the npm JSON viewer both install an executable named fx. The coding agent's MCP help
 *  screen identifies it even before its first profile exists. */
function isFxAgent(bin: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
  const result = spawnShim(bin, ["mcp", "--help"], env, { ...limits, cwd });
  return result.status === 0 && String(result.stdout).trimStart().toLowerCase().startsWith(FX_HELP_PREFIX);
}

/** fx is found by its profile dir, like every other agent's config dir, or by an fx on PATH that is the coding agent.
 *  fx has no Windows build, so on Windows an fx on PATH is never the agent and nothing is run to find out. */
export function detectFx(env: NodeJS.ProcessEnv, cwd: string, profileExists: boolean): boolean {
  if (profileExists) return true;
  if (process.platform === "win32") return false;
  const bin = whichBin("fx", env);
  return bin !== undefined && isFxAgent(bin, env, cwd);
}

/** The fx coding agent on PATH, or the WARN that explains why fx did not check the entry. */
function fxAgentBin(env: NodeJS.ProcessEnv, cwd: string): { bin: string } | FxConfigCheck {
  const bin = whichBin("fx", env);
  if (bin === undefined) return { ok: true, warn: true, detail: FX_PATH_UNAVAILABLE };
  return isFxAgent(bin, env, cwd) ? { bin } : { ok: true, warn: true, detail: FX_NOT_AGENT };
}

/** fx names the profile by the path it opened, so a linked ~/.fx can come back as the link or as its target. */
function sameFile(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

function ownProfile(server: Record<string, unknown> | undefined, file: string): boolean {
  return server?.name === SERVER_KEY && server.source === FX_LIST_SOURCE && typeof server.file === "string" && sameFile(server.file, file) && server.transport === FX_LIST_TRANSPORT;
}

export function checkFxConfig(env: NodeJS.ProcessEnv, cwd: string, file: string): FxConfigCheck {
  const agent = fxAgentBin(env, cwd);
  return "bin" in agent ? checkConfig(agent.bin, env, cwd, file) : agent;
}

function checkConfig(bin: string, env: NodeJS.ProcessEnv, cwd: string, file: string): FxConfigCheck {
  const result = spawnShim(bin, ["mcp", "list", "--json"], env, { ...limits, cwd });
  if (result.error || result.status !== 0) return { ok: false, detail: FX_CONFIG_LIST_FAILED, fix: FX_PROFILE_FIX(file) };
  try {
    const parsed = JSON.parse(String(result.stdout));
    if (!Array.isArray(parsed?.servers)) throw new Error("missing server list");
    const own = parsed.servers.find((server: Record<string, unknown>) => server?.name === SERVER_KEY);
    if (ownProfile(own, file) && own.status === FX_LIST_IDLE && own.error === null) return { ok: true };
    return { ok: false, detail: FX_CONFIG_REJECTED(file), fix: FX_LIST_FIX(file) };
  } catch {
    return { ok: false, detail: FX_CONFIG_LIST_INVALID, fix: FX_PROFILE_FIX(file) };
  }
}

/** Verify the own entry through fx so its environment filtering, selected env alias, expansion and startup policy
 *  match the host. Never shows a project or unrelated server; `show` gives the server fx's own start allowance. */
export function checkFxMcp(env: NodeJS.ProcessEnv, cwd: string, file: string, tools: readonly string[]): FxConfigCheck {
  const agent = fxAgentBin(env, cwd);
  if (!("bin" in agent)) return agent;
  const config = checkConfig(agent.bin, env, cwd, file);
  if (!config.ok) return config;
  const result = spawnShim(agent.bin, ["mcp", "show", SERVER_KEY, "--json"], env, { ...limits, timeout: FX_SHOW_TIMEOUT_MS, cwd });
  if (result.error || result.status !== 0) return { ok: false, detail: FX_MCP_START_FAILED, fix: FX_START_FIX(file) };
  try {
    const server = JSON.parse(String(result.stdout));
    const got = Array.isArray(server?.tools) ? server.tools.map((tool: Record<string, unknown>) => tool?.name).sort() : [];
    if (ownProfile(server, file) && server.status === FX_SHOW_READY && server.error === null && JSON.stringify(got) === JSON.stringify([...tools].sort())) return { ok: true };
    return { ok: false, detail: FX_MCP_NOT_READY, fix: FX_START_FIX(file) };
  } catch {
    return { ok: false, detail: FX_MCP_RESULT_INVALID, fix: FX_START_FIX(file) };
  }
}
