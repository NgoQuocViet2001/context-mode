import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAdapter, hasRecall, hasReplace } from "../../src/adapters/table.ts";
import { TOOL_ORDER } from "../../src/core/contracts/constants.ts";
import { checkHookRoundTrip } from "../../src/core/ops/doctor-hook.ts";
import { checkHostConfig } from "../../src/core/ops/doctor-config.ts";
import { mergeOwnEntries, ownMcpKey } from "../../src/core/ops/host-config.ts";
import { resolvePluginRoot } from "../../src/core/ops/plugin-root.ts";
import { runUninstall } from "../../src/core/ops/uninstall.ts";
import { fxDirOf } from "../../src/core/project/config-dir.ts";
import { buildRegistry, detectAgents, printPlan, runDoctor, runRemove, runSetup } from "../../src/setup/index.ts";

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "cm-fx-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const pkgDir = path.join(root, "pkg");
  const fxHome = path.join(home, ".fx");
  mkdirSync(home); mkdirSync(pkgDir); mkdirSync(fxHome);
  const env = { HOME: home, USERPROFILE: home, FX_HOME: path.join(root, "ignored-development-profile"), CONTEXT_MODE_DATA_DIR: path.join(root, "data"), PATH: path.dirname(process.execPath) };
  writeFileSync(path.join(pkgDir, "server.mjs"), `
import { createInterface } from 'node:readline';
const tools = ${JSON.stringify([...TOOL_ORDER])};
createInterface({ input: process.stdin }).on('line', l => {
 const m = JSON.parse(l); if (m.id === undefined) return;
 const result = m.method === 'initialize' ? { protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'context-mode',version:'2.1.8'} }
 : { tools: tools.map(name => ({name,inputSchema:{type:'object'}})) };
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
  // An attempted fabricated hook run must fail the setup, not silently pass.
  writeFileSync(path.join(pkgDir, "hook.mjs"), "process.exit(42);\n");
  cpSync(path.join(import.meta.dirname, "..", "..", "skills"), path.join(pkgDir, "skills"), { recursive: true });
  cpSync(path.join(import.meta.dirname, "..", "..", "skills"), path.join(pkgDir, "pi", "skills"), { recursive: true });
  return { root, home, pkgDir, fxHome, env, agents: ["fx"] };
}

const fx = getAdapter("fx");
test("fx exposes MCP and skills without advertising external hooks or automatic recall", async () => {
  assert.equal(fx.toolNamePrefix, "mcp_context-mode_");
  assert.equal(fx.hookChannel.kind, "none");
  assert.deepEqual(fx.eventMap, {});
  assert.equal(fx.compactDelivery, "none");
  assert.equal(hasReplace(fx), false);
  assert.equal(hasRecall(fx), false);
  assert.throws(() => fx.decode({}), /no external command-hook channel/);
  const row = await checkHookRoundTrip({ agent: "fx" });
  assert.equal(row.status, "WARN");
  assert.match(row.detail, /interception.*unavailable/);
});

test("fx stable profile discovery mirrors 0.0.16 and ignores unreleased FX_HOME", t => {
  const s = sandbox(t);
  assert.equal(fxDirOf({}, s.home), path.join(s.home, ".fx"));
  assert.equal(fxDirOf({ FX_HOME: "" }, s.home), path.join(s.home, ".fx"));
  for (const value of ["relative", path.parse(s.home).root, s.home]) assert.equal(fxDirOf({ FX_HOME: value }, s.home), s.fxHome);
  const ctx = { home: s.home, pkgDir: s.pkgDir, env: s.env };
  const registry = buildRegistry(ctx);
  assert.ok(detectAgents(registry, ctx).includes("fx"));
  const row = registry.find(r => r.id === "fx");
  assert.equal(row.config.file, path.join(s.fxHome, "mcp.json"));
  assert.equal(row.skillInstall.dir, path.join(s.fxHome, "skills"));
  assert.equal(row.hookCommand, undefined);
  assert.equal(row.allowedWrites.some(f => /hooks?\.json$/.test(f)), false);
  assert.equal(printPlan(row).steps.some(s => s.kind === "hook"), false);
});

for (const container of ["mcpServers", "mcp"]) test(`fx setup, doctor and remove preserve ${container}, user settings, entry options and original bytes`, async t => {
  const s = sandbox(t);
  const file = path.join(s.fxHome, "mcp.json");
  const before = JSON.stringify({ future: { keep: "✓" }, [container]: { other: { command: "other" }, "context-mode": { command: "old", args: [], env: { KEEP: "yes" }, timeout: 90 } } }, null, 2) + "\n";
  writeFileSync(file, before);
  const settings = path.join(s.fxHome, "settings.json");
  const settingsBefore = '{"model":"keep/model","effort":"high","permission_mode":"ask"}\n';
  writeFileSync(settings, settingsBefore);
  const result = await runSetup({ ...s, runId: "fx-install" });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(Object.hasOwn(after, container === "mcp" ? "mcpServers" : "mcp"), false);
  assert.deepEqual(after.future, { keep: "✓" });
  assert.deepEqual(after[container].other, { command: "other" });
  assert.deepEqual(after[container]["context-mode"].env, { KEEP: "yes" });
  assert.equal(after[container]["context-mode"].timeout, 90);
  assert.deepEqual(after[container]["context-mode"].args, [path.join(s.pkgDir, "server.mjs"), "--agent", "fx"]);
  assert.equal(readFileSync(settings, "utf8"), settingsBefore);
  assert.equal(existsSync(s.env.FX_HOME), false);
  for (const name of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) {
    const text = readFileSync(path.join(s.fxHome, "skills", name, "SKILL.md"), "utf8");
    assert.match(text, /mcp_context-mode_ctx_/);
  }
  const hooks = result.agents[0].checks.filter(c => c.name.startsWith("hook"));
  assert.equal(hooks.length, 3);
  assert.ok(hooks.every(c => c.ok && c.warn && /no external/.test(c.detail)));
  const again = await runSetup({ ...s, runId: "fx-idempotent" });
  assert.equal(again.exitCode, 0, JSON.stringify(again));
  assert.equal(again.agents[0].changes.length, 0);
  const doc = await runDoctor(s);
  assert.equal(doc.exitCode, 0, JSON.stringify(doc));
  assert.equal(resolvePluginRoot(fx, s.env), s.pkgDir);
  const oldArgv = process.argv[1];
  try {
    process.argv[1] = path.join(s.pkgDir, "server.mjs");
    assert.equal(checkHostConfig(fx, s.env, s.home).status, "PASS");
  } finally { process.argv[1] = oldArgv; }
  const removed = runRemove(s);
  assert.equal(removed.exitCode, 0, JSON.stringify(removed));
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(readFileSync(settings, "utf8"), settingsBefore);
  assert.equal(existsSync(path.join(s.fxHome, "skills", "ctx-doctor", "SKILL.md")), false);
});

test("fx rejects ambiguous and non-object MCP containers before mutating config", async t => {
  const s = sandbox(t);
  const file = path.join(s.fxHome, "mcp.json");
  for (const before of ['{"mcp":{},"mcpServers":{}}', '{"mcp":[]}', '{"mcpServers":null}', '{broken']) {
    writeFileSync(file, before);
    const result = await runSetup({ ...s, runId: "bad" + before.length });
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(existsSync(path.join(s.fxHome, "skills", "ctx-doctor", "SKILL.md")), false);
  }
  assert.throws(() => ownMcpKey("fx", { mcp: {}, mcpServers: {} }), /both/);
});

for (const container of ["mcp", "mcpServers"]) test(`fx ctx upgrade and uninstall keep unrelated ${container} entries`, t => {
  const s = sandbox(t);
  const file = path.join(s.fxHome, "mcp.json");
  const before = { [container]: { other: { command: "keep" }, "context-mode": { command: "old", args: [], env: { KEEP: "yes" } } }, user: 7 };
  const updated = mergeOwnEntries("fx", JSON.stringify(before), "json", fx);
  const value = JSON.parse(updated.text);
  assert.equal(value[container]["context-mode"].env.KEEP, "yes");
  assert.equal(value.user, 7);
  assert.deepEqual(value[container].other, { command: "keep" });
  writeFileSync(file, updated.text);
  const removed = runUninstall({ adapter: fx, env: s.env, project: { projectKey: "synthetic-fx" }, confirmDelete: false });
  assert.ok(removed.rows.some(r => r.after === "removed"));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { [container]: { other: { command: "keep" } }, user: 7 });
});

test("fx fresh setup creates only its MCP and supported skills, and remove removes those files", async t => {
  const s = sandbox(t);
  const file = path.join(s.fxHome, "mcp.json");
  const result = await runSetup({ ...s, runId: "fresh" });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(existsSync(file), true);
  assert.equal(Object.keys(JSON.parse(readFileSync(file, "utf8"))).join(), "mcpServers");
  assert.equal(existsSync(path.join(s.fxHome, "hooks.json")), false);
  assert.equal(existsSync(path.join(s.fxHome, "settings.json")), false);
  assert.equal(runRemove(s).exitCode, 0);
  assert.equal(existsSync(file), false);
});

test("fx refuses disabled, malformed and non-stdio own entries and doctor never reports those PASS", async t => {
  const s = sandbox(t);
  const file = path.join(s.fxHome, "mcp.json");
  for (const own of [{ enabled: false }, { enabled: "false" }, { type: "http", url: "https://example.invalid/mcp" }, { url: "https://example.invalid/mcp" }, { env: { INVALID: 42 } }]) {
    const before = JSON.stringify({ mcpServers: { "context-mode": { command: "old", ...own } } });
    writeFileSync(file, before);
    const result = await runSetup({ ...s, runId: "held" });
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(checkHostConfig(fx, s.env, s.home).status, "FAIL");
    assert.equal(existsSync(path.join(s.fxHome, "skills", "ctx-doctor", "SKILL.md")), false);
  }
  for (const before of ['{"mcp":{},"mcp":{}}', '{"mcpServers":{"other":{"command":"one","command":"two"}}}']) {
    writeFileSync(file, before);
    const result = await runSetup({ ...s, runId: "duplicates" });
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.equal(readFileSync(file, "utf8"), before);
  }
});

test("fx config and backup remain private on POSIX and rollback restores original permissions", { skip: process.platform === "win32" }, async t => {
  const { chmodSync, statSync } = await import("node:fs");
  const s = sandbox(t);
  const file = path.join(s.fxHome, "mcp.json");
  writeFileSync(file, '{"mcpServers":{"other":{"command":"keep","env":{"SECRET":"synthetic"}}}}\n');
  chmodSync(file, 0o640);
  const result = await runSetup({ ...s, runId: "private" });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const manifest = JSON.parse(readFileSync(path.join(result.backupDir, "manifest.json"), "utf8"));
  for (const entry of manifest.entries.filter(e => e.backup)) assert.equal(statSync(path.join(result.backupDir, entry.backup)).mode & 0o777, 0o600);
  assert.equal(runRemove(s).exitCode, 0);
  assert.equal(statSync(file).mode & 0o777, 0o640);
});
