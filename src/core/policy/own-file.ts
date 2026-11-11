// D-R48-OWN-FILE-1 (#1326): is this Read target one of the agent's own instruction or skill files?
// Skill references, rule files and CLAUDE.md sit in the agent's own config dir (Claude Code: ~/.claude or
// $CLAUDE_CONFIG_DIR, plugin skills under plugins/cache) or in the shared ~/.agents/skills dir. They are
// instructions: the agent needs the whole text, so the Read deny and the PostToolUse replace let them through.
// Only Markdown files count; transcripts (.jsonl) and other data in the same dirs keep the normal rules.
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { AgentId } from "../contracts/agents.ts";
import { AGENT_FILE_EXT, AGENT_HOME_DIR, SHARED_SKILLS_DIR } from "../contracts/constants.ts";
import {
  claudeDirOf, codexDirOf, copilotDirOf, geminiDirOf, homeDirOf, kiroDirOf, opencodeDirOf, piAgentDirOf, vscodeUserDirOf,
} from "../project/config-dir.ts";
import { isInside, isInsideAny } from "../project/contain.ts";

/** The dirs this agent reads its own instruction and skill files from, plus the shared skill dir. */
export function ownDirsOf(agent: AgentId, env: NodeJS.ProcessEnv): string[] {
  const home = homeDirOf(env);
  if (home === null) return [];
  const shared = join(home, ...SHARED_SKILLS_DIR);
  const own = agent === "claude-code" ? [claudeDirOf(env, home)]
    : agent === "codex" ? [codexDirOf(env, home)]
    : agent === "gemini" ? [geminiDirOf(env, home)]
    : agent === "copilot-cli" ? [copilotDirOf(env, home)]
    : agent === "kiro" ? [kiroDirOf(env, home)]
    : agent === "opencode" ? [opencodeDirOf(env, home)]
    : agent === "pi" ? [piAgentDirOf(env, home)]
    : agent === "vscode" ? [join(home, ...AGENT_HOME_DIR.vscode), vscodeUserDirOf(env, home)]
    : [join(home, ...AGENT_HOME_DIR[agent])];
  return [...own, shared];
}

/** True when `abs` is a Markdown file inside one of this agent's own dirs (by realpath components). */
export function isOwnFile(agent: AgentId, abs: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (extname(abs).toLowerCase() !== AGENT_FILE_EXT) return false;
  const dirs = ownDirsOf(agent, env);
  if (isInsideAny(dirs, abs)) return true;
  // A skill may itself be linked to a checkout outside the config dir. Anchor at
  // that installed skill; an unrelated link escaping its target is still external.
  const shared = dirs.at(-1);
  return dirs.some((dir) => {
    const skills = dir === shared ? dir : join(dir, "skills");
    const rel = relative(skills, abs);
    const [name, file] = rel.split(sep);
    return !!name && !!file && name !== ".." && !isAbsolute(rel) && isInside(join(skills, name), abs);
  });
}
