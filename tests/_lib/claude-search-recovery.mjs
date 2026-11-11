// Imported by the ADR-0016 owning suite. No model or MCP server is started by these cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { handleHook, mainLabel } from "../../src/core/hooks/dispatch.ts";
import { localSearchCommand } from "../../src/core/hooks/search-recovery.ts";
import { resolveProject } from "../../src/core/project/resolve.ts";
import { openDb, closeDb } from "../../src/core/store/db.ts";
import { ctxSearch } from "../../src/core/tools/search.ts";
import { searchFixture } from "./local-search-fixture.mjs";

const body = Array.from({ length: 200 }, (_, i) => `record ${i} ${"x".repeat(70)}`).join("\n") + "\nheldout_58137";
const replacement = (out) => JSON.parse(out.stdout || "{}").hookSpecificOutput?.updatedToolOutput;
const text = (out) => typeof out === "string" ? out
  : Array.isArray(out) ? out.map((block) => block.text || "").join("\n") : out?.stdout;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ctx-recovery-"));
  const repo = join(root, "repo quote' $(echo injected) ` & Σ");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const env = {
    ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, ".claude"),
    CONTEXT_MODE_DATA_DIR: join(root, "actual-data"), CLAUDE_PROJECT_DIR: repo,
    CLAUDE_PLUGIN_ROOT: searchFixture(join(root, "bundle")),
  };
  const savedDataRoot = process.env.CONTEXT_MODE_DATA_DIR;
  process.env.CONTEXT_MODE_DATA_DIR = env.CONTEXT_MODE_DATA_DIR;
  const project = resolveProject("claude-code", { env, argv: ["node", "hook.mjs", "--agent", "claude-code"], cwd: repo });
  let db;
  t.after(() => {
    if (db) closeDb(db);
    if (savedDataRoot === undefined) delete process.env.CONTEXT_MODE_DATA_DIR;
    else process.env.CONTEXT_MODE_DATA_DIR = savedDataRoot;
    // Hook-owned handles live until process exit; Windows can retain their temp WAL files.
    try { rmSync(root, { recursive: true, force: true }); }
    catch (err) { if (process.platform !== "win32" || err.code !== "EPERM") throw err; }
  });
  const open = async () => db ??= await openDb(project);
  const payload = (extra = {}) => ({
    session_id: "session-a", cwd: repo, hook_event_name: "PostToolUse", tool_name: "Bash",
    tool_use_id: "call-a", tool_input: { command: "synthetic not executed" },
    tool_response: { stdout: body, stderr: "", interrupted: false }, ...extra,
  });
  function agent(name, tools, synced = false) {
    const dir = synced ? join(root, ".claude/plugins/synced/id/synthetic/agents") : join(repo, ".claude/agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name + ".md"), `---\nname: ${name}\ntools: ${tools}\n---\n`);
  }
  return { root, repo, env, project, open, payload, agent };
}

test("#1342 declared shell recovery works; no-shell and unresolved callers preserve output", async (t) => {
  const f = fixture(t);
  f.agent("shell", "Bash");
  f.agent("read", "Read");
  f.agent("ctx", "Read, mcp__plugin_context-mode_context-mode__ctx_search");
  const out = replacement(await handleHook("claude-code", f.payload({ agent_id: "a", agent_type: "shell" }), f.env));
  assert.match(text(out), /Without MCP, run:/);
  assert.doesNotMatch(text(out), /ctx_search/);
  const db = await f.open();
  const id = db.raw.prepare("SELECT id FROM sources ORDER BY id DESC LIMIT 1").get().id;
  for (const shell of process.platform === "win32" ? ["Bash", "PowerShell"] : ["Bash"]) {
    const command = localSearchCommand(f.project, id, f.env, shell, "heldout_58137");
    const before = await handleHook("claude-code", f.payload({
      hook_event_name: "PreToolUse", agent_id: "a", agent_type: "shell", tool_input: { command },
    }), f.env);
    assert.equal(before.stdout, "", "the native hook permits the recovery command");
    const args = shell === "PowerShell" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
    const exe = shell === "PowerShell" ? "powershell.exe"
      : process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
    const result = spawnSync(exe, args, {
      cwd: tmpdir(), encoding: "utf8",
      env: { ...f.env, CONTEXT_MODE_DATA_DIR: join(f.root, "wrong-data"), CLAUDE_PROJECT_DIR: tmpdir() },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /heldout_58137/);
  }
  f.agent("empty", "[]");
  for (const type of ["empty", "read", "general-purpose", "Explore", "fork", "missing"]) {
    assert.equal(replacement(await handleHook("claude-code", f.payload({ agent_id: "b", agent_type: type }), f.env)), undefined, type);
  }
  assert.equal(replacement(await handleHook("claude-code", f.payload({ agent_type: "read" }), f.env)), undefined);
  assert.equal(replacement(await handleHook("claude-code", f.payload({ agent_id: "c", agent_type: "ctx" }), f.env)), undefined,
    "a ctx-capable caller keeps the established case-A behavior");
});

test("synced plugin tools are resolved; conflicting synced copies remain unknown", async (t) => {
  const f = fixture(t);
  f.agent("worker", "Bash", true);
  assert.match(text(replacement(await handleHook("claude-code", f.payload({
    agent_id: "s", agent_type: "synthetic:worker",
  }), f.env))), /Without MCP/);
  const dir = join(f.root, ".claude/plugins/synced/other/synthetic/agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "worker.md"), "---\ntools: Read\n---\n");
  assert.equal(replacement(await handleHook("claude-code", f.payload({
    agent_id: "s", agent_type: "synthetic:worker",
  }), f.env)), undefined);
});

test("#1343 child identity and source handles distinguish repeated or absent call IDs", async (t) => {
  const f = fixture(t);
  f.agent("shell", "Bash");
  const event = { agent: "claude-code", turn: 0 };
  assert.equal(mainLabel({ canonicalName: "Read", input: { file_path: "/fixture/log" }, callId: "read-1" }, event),
    "Read:/fixture/log#read-1");
  const db = await f.open();
  const handles = [];
  for (const n of [1, 2]) {
    const out = replacement(await handleHook("claude-code", f.payload({
      agent_id: "child-" + n, agent_type: "shell", tool_use_id: "same-id",
      tool_name: "mcp__fixture__note", tool_input: {},
      tool_response: [{ type: "text", text: body + "\nneedle" + n }],
    }), f.env));
    const numericId = Number(text(out).match(/'([0-9]+)' '' '--context'/)?.[1]);
    assert.ok(Number.isSafeInteger(numericId));
    handles.push("s" + numericId.toString(36));
  }
  assert.equal(new Set(db.raw.prepare("SELECT label FROM sources").all().map((r) => r.label)).size, 2);
  assert.notEqual(handles[0], handles[1]);
  for (let i = 0; i < 2; i++) {
    const reply = await ctxSearch.handler({ queries: ["needle"], source: handles[i] }, {
      project: f.project, sessionId: "session-a", turn: 0, signal: new AbortController().signal,
    });
    assert.match(reply.text, new RegExp("needle" + (i + 1)));
    assert.doesNotMatch(reply.text, new RegExp("needle" + (2 - i)));
  }
  for (let n = 0; n < 2; n++) {
    await handleHook("claude-code", f.payload({ tool_use_id: undefined, agent_id: "missing-id", agent_type: "shell" }), f.env);
  }
  assert.equal(new Set(db.raw.prepare("SELECT label FROM sources").all().map((r) => r.label)).size, 4);
});

test("small Read stays store-free; a missing search sidecar preserves child output", async (t) => {
  const f = fixture(t);
  const payload = f.payload({ tool_name: "Read", tool_input: { file_path: "small" },
    tool_response: { type: "text", file: { content: "small", filePath: "small", numLines: 1, startLine: 1, totalLines: 1 } } });
  assert.equal(replacement(await handleHook("claude-code", payload, f.env)), undefined);
  assert.equal(existsSync(f.project.dbPath), false);
  f.agent("shell", "Bash");
  assert.equal(replacement(await handleHook("claude-code", f.payload({ agent_id: "a", agent_type: "shell" }),
    { ...f.env, CLAUDE_PLUGIN_ROOT: join(f.root, "absent") })), undefined);
});

test("a user-denied shell cannot become a recovery dead end", async (t) => {
  const f = fixture(t);
  f.agent("both", "Bash, Read");
  writeFileSync(join(f.repo, ".claude/settings.json"), JSON.stringify({ permissions: { deny: ["Bash(*)"] } }));
  const out = await handleHook("claude-code", f.payload({ agent_id: "a", agent_type: "both",
    tool_name: "Read", tool_input: { file_path: "synthetic" }, tool_response: body }), f.env);
  assert.equal(replacement(out), undefined);
});
