// tests/0026-fx-mcp-client.test.mjs
// Area: ADR-0026 (proposed): fx as an MCP client with no hook channel (D-FX-MCP-1). One file per ADR area (ADR-0024).
// The fx code loads in before(), so on a tree without it the fx cases fail one by one instead of the file.
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HOOK_HOST_IDS } from "./_lib/hook-hosts.mjs";
import { ADAPTERS, getAdapter, hasRecall, hasReplace } from "../src/adapters/table.ts";
import { TOOL_ORDER } from "../src/core/contracts/constants.ts";
import { checkHookRoundTrip } from "../src/core/ops/doctor-hook.ts";
import { checkHostConfig } from "../src/core/ops/doctor-config.ts";
import { HOST_SHAPES } from "../src/core/ops/hook-shape.ts";
import { mergeOwnEntries } from "../src/core/ops/host-config.ts";
import { resolvePluginRoot } from "../src/core/ops/plugin-root.ts";
import { runUninstall } from "../src/core/ops/uninstall.ts";
import { buildRegistry, detectAgents, printPlan, runDoctor, runRemove, runSetup } from "../src/setup/index.ts";

let C; // src/core/contracts/constants.ts, read after load so the FX_* names may be absent
let ownMcpKey;
let fxModule;
before(async () => {
  C = await import("../src/core/contracts/constants.ts");
  ({ ownMcpKey } = await import("../src/core/ops/host-config.ts"));
  fxModule = await import("../src/adapters/fx.ts").catch(() => undefined);
});

describe("ADR-0026 (proposed): fx adapter row", () => {
  test("fx exposes MCP and skills without advertising external hooks or automatic recall", async () => {
    const row = getAdapter("fx");
    assert.equal(row.toolNamePrefix, "mcp_context-mode_");
    assert.equal(row.hookChannel.kind, "none");
    assert.deepEqual(row.eventMap, {});
    assert.equal(row.compactDelivery, "none");
    assert.equal(hasReplace(row), false);
    assert.equal(hasRecall(row), false);
    assert.throws(() => row.decode({}), /no external command-hook channel/);
    assert.throws(() => row.encode({ event: "PostToolUse", agent: "fx" }, { kind: "replace", output: "fabricated" }), /no external command-hook channel/);
    const check = await checkHookRoundTrip({ agent: "fx" });
    assert.equal(check.status, "WARN");
    assert.match(check.detail, /interception.*unavailable/);
  });
  test("the table is the ten ADR-0020 hook hosts plus fx, and fx is the only row with no hook channel", () => {
    assert.deepEqual(ADAPTERS.map((r) => r.id), [...HOOK_HOST_IDS, "fx"]);
    assert.deepEqual(ADAPTERS.filter((r) => r.hookChannel.kind === "none").map((r) => r.id), ["fx"]);
  });

  test("fx row: hook channel none with no reply shape, skills in ~/.fx/skills, and its own decode and encode", () => {
    const row = getAdapter("fx");
    assert.deepEqual(row.hookChannel, { kind: "none", path: "" });
    assert.deepEqual(row.skillChannel, { kind: "home-dir", path: ".fx/skills" });
    assert.equal(HOST_SHAPES.fx, null, "no fabricated native hook schema");
    assert.equal(row.toolNamePrefix, fxModule?.TOOL_NAME_PREFIX);
    assert.equal(row.decode, fxModule?.decode);
    assert.equal(row.encode, fxModule?.encode);
  });
});

// ADR-0026 (proposed, D-FX-MCP-1): fx is an MCP client with no external hook channel. Setup writes ~/.fx/mcp.json and the three
// skills; fx itself (fx mcp list and fx mcp show) confirms it loads and starts the entry when the coding agent is on PATH.
describe("ADR-0026 (proposed): fx MCP profile (setup, doctor, remove)", () => {
  const FX_SKILLS = path.join(import.meta.dirname, "..", "skills");

  /** A home with ~/.fx, a stub MCP server that answers the handshake and tools/list, and a hook that always fails
   *  (an attempted fabricated hook run must fail the setup, not silently pass). FX_HOME points elsewhere: fx 0.0.16
   *  ignores it. PATH is only `bin`, where a test puts its fake fx: an fx installed next to node (an npm global, such
   *  as the JSON viewer) stays out of the tests. */
  function fxSandbox(t) {
    // The real path: Windows runners set TEMP as an 8.3 short path, and setup and fx name the long one.
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-fx-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const pkgDir = path.join(root, "pkg");
    const fxHome = path.join(home, ".fx");
    const bin = path.join(root, "bin");
    mkdirSync(home); mkdirSync(pkgDir); mkdirSync(fxHome); mkdirSync(bin);
    const env = { HOME: home, USERPROFILE: home, FX_HOME: path.join(root, "ignored-development-profile"), CONTEXT_MODE_DATA_DIR: path.join(root, "data"), PATH: bin, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}) };
    writeFileSync(path.join(pkgDir, "server.mjs"), `
  import { createInterface } from 'node:readline';
  const tools = ${JSON.stringify([...TOOL_ORDER])};
  createInterface({ input: process.stdin }).on('line', l => {
   const m = JSON.parse(l); if (m.id === undefined) return;
   const result = m.method === 'initialize' ? { protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'context-mode',version:'2.1.8'} }
   : { tools: tools.map(name => ({name,inputSchema:{type:'object'}})) };
   process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
  });`);
    writeFileSync(path.join(pkgDir, "hook.mjs"), "process.exit(42);\n");
    cpSync(FX_SKILLS, path.join(pkgDir, "skills"), { recursive: true });
    cpSync(FX_SKILLS, path.join(pkgDir, "pi", "skills"), { recursive: true });
    return { root, home, pkgDir, fxHome, bin, file: path.join(fxHome, "mcp.json"), env, agents: ["fx"] };
  }

  /** An `fx` executable in `bin` running `source`, through the same lookup and shim path real host checks use on each
   *  OS. A controlled CLI fixture, not a real fx or model session. */
  function fakeFx(bin, source) {
    mkdirSync(bin, { recursive: true });
    const script = path.join(bin, "fx-fixture.mjs");
    writeFileSync(script, source);
    // The shim names the script relative to itself (%~dp0), so a TEMP with spaces or non-ASCII letters still starts it.
    if (process.platform === "win32") writeFileSync(path.join(bin, "fx.cmd"), `@"${process.execPath}" "%~dp0fx-fixture.mjs" %*\r\n`);
    else {
      const file = path.join(bin, "fx");
      writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(file, 0o755);
    }
  }

  /** The help line `fx mcp --help` prints for the fx coding agent; the npm JSON viewer named fx prints other text. */
  const FX_AGENT_HELP = "usage: fx mcp COMMAND";

  /** Run `fn` with process.argv[1] at the sandbox server, as ctx_doctor's D3 check sees it from inside the server. */
  function asServer(s, fn) {
    const old = process.argv[1];
    process.argv[1] = path.join(s.pkgDir, "server.mjs");
    try { return fn(); } finally { process.argv[1] = old; }
  }

  const fxRow = getAdapter("fx");
  const launchArgs = s => [path.join(s.pkgDir, "server.mjs"), "--agent", "fx"];
  const pick = c => ({ ok: c.ok, warn: c.warn, detail: c.detail });

  test("fx stable profile discovery mirrors 0.0.16 and ignores unreleased FX_HOME", t => {
    const s = fxSandbox(t);
    const ctx = { home: s.home, pkgDir: s.pkgDir, env: s.env };
    const registry = buildRegistry(ctx);
    assert.ok(detectAgents(registry, ctx).includes("fx"));
    const row = registry.find(r => r.id === "fx");
    assert.equal(row.config.file, s.file);
    assert.equal(row.skillInstall.dir, path.join(s.fxHome, "skills"));
    assert.equal(row.hookCommand, undefined);
    assert.equal(row.allowedWrites.some(f => /hooks?\.json$/.test(f)), false);
    assert.equal(printPlan(row).steps.some(step => step.kind === "hook"), false);
  });

  test("fx discovery distinguishes the coding agent from the JSON viewer with the same executable name, and runs no fx on Windows", t => {
    const s = fxSandbox(t);
    rmSync(s.fxHome, { recursive: true });
    const ran = path.join(s.root, "ran.txt");
    const agent = process.platform !== "win32"; // fx has no Windows build: an fx on a Windows PATH is not the agent
    for (const [help, expected] of [[FX_AGENT_HELP, agent], ["Usage: fx [flags] [code...]", false]]) {
      fakeFx(s.bin, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(ran)}, 'x');
if (process.argv.slice(2).join(' ') !== 'mcp --help') process.exit(2); process.stdout.write(${JSON.stringify(help)}+'\\n');`);
      assert.equal(detectAgents(buildRegistry(s), s).includes("fx"), expected);
      assert.equal(existsSync(s.fxHome), false);
    }
    assert.equal(existsSync(ran), agent, "detection runs fx only where fx has a build");
    writeFileSync(s.fxHome, "");
    assert.equal(detectAgents(buildRegistry(s), s).includes("fx"), false, "a file named .fx is not a profile");
    rmSync(s.fxHome);
    mkdirSync(s.fxHome);
    assert.ok(detectAgents(buildRegistry(s), s).includes("fx"), "a profile is found even when the fx on PATH is the JSON viewer");
  });

  for (const container of ["mcpServers", "mcp"]) test(`fx setup, doctor and remove preserve ${container}, user settings, entry options and original bytes`, async t => {
    const s = fxSandbox(t);
    const before = JSON.stringify({ future: { keep: "✓" }, [container]: { other: { command: "other" }, "context-mode": { command: "old", args: [], env: { KEEP: "yes" }, timeout: 90 } } }, null, 2) + "\n";
    writeFileSync(s.file, before);
    const settings = path.join(s.fxHome, "settings.json");
    const settingsBefore = '{"model":"keep/model","effort":"high","permission_mode":"ask"}\n';
    writeFileSync(settings, settingsBefore);
    const result = await runSetup({ ...s, runId: "fx-install" });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const after = JSON.parse(readFileSync(s.file, "utf8"));
    assert.equal(Object.hasOwn(after, container === "mcp" ? "mcpServers" : "mcp"), false);
    assert.deepEqual(after.future, { keep: "✓" });
    assert.deepEqual(after[container].other, { command: "other" });
    const own = after[container]["context-mode"];
    assert.deepEqual(own.env, { KEEP: "yes", CONTEXT_MODE_DATA_DIR: s.env.CONTEXT_MODE_DATA_DIR });
    assert.equal(own.timeout, 90);
    assert.deepEqual(own.args, launchArgs(s));
    assert.equal(readFileSync(settings, "utf8"), settingsBefore);
    assert.equal(existsSync(s.env.FX_HOME), false);
    for (const name of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) {
      assert.match(readFileSync(path.join(s.fxHome, "skills", name, "SKILL.md"), "utf8"), /mcp_context-mode_ctx_/);
    }
    const checks = result.agents[0].checks;
    const hooks = checks.filter(c => c.name.startsWith("hook"));
    assert.equal(hooks.length, 3);
    assert.ok(hooks.every(c => c.ok && c.warn && /no external/.test(c.detail)));
    assert.equal(new Set(checks.map(c => c.name)).size, checks.length, "one diagnostic row per check");
    assert.deepEqual(pick(checks.find(c => c.name === "native-mcp")), { ok: true, warn: true, detail: C.FX_PATH_UNAVAILABLE }, "missing fx leaves native acceptance unverified");
    assert.equal(checks.find(c => c.name === "mcp").ok, true, "direct protocol check is separate from native acceptance");
    const again = await runSetup({ ...s, runId: "fx-idempotent" });
    assert.equal(again.exitCode, 0, JSON.stringify(again));
    assert.equal(again.agents[0].changes.length, 0);
    const doc = await runDoctor(s);
    assert.equal(doc.exitCode, 0, JSON.stringify(doc));
    assert.equal(resolvePluginRoot(fxRow, s.env), s.pkgDir);
    const d3 = asServer(s, () => checkHostConfig(fxRow, s.env, s.home));
    assert.deepEqual({ status: d3.status, detail: d3.detail }, { status: "WARN", detail: C.FX_PATH_UNAVAILABLE });
    const removed = runRemove(s);
    assert.equal(removed.exitCode, 0, JSON.stringify(removed));
    assert.equal(readFileSync(s.file, "utf8"), before);
    assert.equal(readFileSync(settings, "utf8"), settingsBefore);
    assert.equal(existsSync(path.join(s.fxHome, "skills", "ctx-doctor", "SKILL.md")), false);
  });

  // fx cancels an MCP call that sends nothing for operation_timeout_ms (default 60000, fx src/core/mcp/mcp_contract.zig);
  // ctx_execute runs up to EXEC_TIMEOUT_MS and reports only at the end; the 30 s margin lets a run that hits that limit
  // still send its reply. An owned field, like zcode's timeoutMs.
  test("fx setup sets operation_timeout_ms above the ctx_execute limit, replacing a lower value, and ctx_upgrade adds it", async t => {
    const s = fxSandbox(t);
    writeFileSync(s.file, JSON.stringify({ mcpServers: { "context-mode": { command: "old", args: [], operation_timeout_ms: 60000 } } }));
    const result = await runSetup({ ...s, runId: "operation-timeout" });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(JSON.parse(readFileSync(s.file, "utf8")).mcpServers["context-mode"][C.FX_OPERATION_TIMEOUT_FIELD], C.FX_OPERATION_TIMEOUT_MS);
    assert.ok(C.FX_OPERATION_TIMEOUT_MS > C.EXEC_TIMEOUT_MS, "fx waits longer than ctx_execute may run");
    const upgraded = JSON.parse(mergeOwnEntries("fx", JSON.stringify({ mcp: { "context-mode": { command: "old", args: [] } } }), "json", fxRow).text);
    assert.equal(upgraded.mcp["context-mode"][C.FX_OPERATION_TIMEOUT_FIELD], C.FX_OPERATION_TIMEOUT_MS);
    const step = printPlan(buildRegistry({ home: s.home, pkgDir: s.pkgDir, env: s.env }).find(r => r.id === "fx")).steps.find(x => x.kind === "config");
    assert.equal(JSON.parse(step.block)[step.key[0]]["context-mode"][C.FX_OPERATION_TIMEOUT_FIELD], C.FX_OPERATION_TIMEOUT_MS);
  });

  // The MCP server and the CLI must share one store: the data root of this setup run replaces an older one in the env
  // map fx reads (environment wins over env); other keys and the map fx ignores stay as they are.
  test("fx setup writes this run's data root into the env map fx reads and keeps the other keys", async t => {
    for (const field of ["env", "environment"]) {
      for (const older of [false, true]) {
        const s = fxSandbox(t);
        const selected = { KEEP: "yes", ...(older ? { CONTEXT_MODE_DATA_DIR: path.join(s.root, "older store") } : {}) };
        const entry = { command: "old", args: [], [field]: selected };
        if (field === "environment") entry.env = { LOWER_PRIORITY: 42 }; // fx ignores this map when environment exists
        writeFileSync(s.file, JSON.stringify({ mcpServers: { "context-mode": entry } }));
        const setup = await runSetup({ ...s, runId: "data-root" });
        assert.equal(setup.exitCode, 0, JSON.stringify(setup));
        const actual = JSON.parse(readFileSync(s.file, "utf8")).mcpServers["context-mode"];
        assert.deepEqual(actual[field], { KEEP: "yes", CONTEXT_MODE_DATA_DIR: s.env.CONTEXT_MODE_DATA_DIR });
        if (field === "environment") assert.deepEqual(actual.env, entry.env);
      }
    }
  });

  // fx reads mcp, or mcpServers when there is no mcp; with both it reads only mcp (fx src/core/mcp/project_config.zig).
  test("fx setup writes into mcp when a profile has both containers, and doctor, plugin root and remove follow it", async t => {
    const s = fxSandbox(t);
    const stale = { command: "stale", args: [] };
    const before = JSON.stringify({ mcp: { other: { command: "other" } }, mcpServers: { "context-mode": stale, keep: { command: "keep" } } }, null, 2) + "\n";
    writeFileSync(s.file, before);
    assert.deepEqual(ownMcpKey("fx", JSON.parse(before)), ["mcp", "context-mode"]);
    const result = await runSetup({ ...s, runId: "both" });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const after = JSON.parse(readFileSync(s.file, "utf8"));
    assert.deepEqual(after.mcp.other, { command: "other" });
    assert.deepEqual(after.mcp["context-mode"].args, launchArgs(s));
    assert.deepEqual(after.mcpServers, { "context-mode": stale, keep: { command: "keep" } }, "fx skips mcpServers here; setup leaves it alone");
    assert.equal((await runDoctor(s)).exitCode, 0);
    assert.equal(resolvePluginRoot(fxRow, s.env), s.pkgDir);
    assert.equal(asServer(s, () => checkHostConfig(fxRow, s.env, s.home)).status, "WARN");
    assert.equal(runRemove(s).exitCode, 0);
    assert.equal(readFileSync(s.file, "utf8"), before);
  });

  for (const container of ["mcp", "mcpServers"]) test(`fx ctx_upgrade refreshes the entry in ${container}, and uninstall keeps the unrelated entries`, t => {
    const s = fxSandbox(t);
    const before = { [container]: { other: { command: "keep" }, "context-mode": { command: "old", args: [], env: { KEEP: "yes" } } }, user: 7 };
    const value = JSON.parse(asServer(s, () => mergeOwnEntries("fx", JSON.stringify(before), "json", fxRow)).text);
    assert.equal(value[container]["context-mode"].command, C.HOST_NODE_COMMAND);
    assert.deepEqual(value[container]["context-mode"].args, launchArgs(s));
    assert.equal(value[container]["context-mode"][C.FX_OPERATION_TIMEOUT_FIELD], C.FX_OPERATION_TIMEOUT_MS);
    assert.equal(value[container]["context-mode"].env.KEEP, "yes");
    assert.equal(value.user, 7);
    assert.deepEqual(value[container].other, { command: "keep" });
    writeFileSync(s.file, JSON.stringify(value));
    const removed = runUninstall({ adapter: fxRow, env: s.env, project: { projectKey: "synthetic-fx" }, confirmDelete: false });
    assert.ok(removed.rows.some(r => r.after === "removed"));
    assert.deepEqual(JSON.parse(readFileSync(s.file, "utf8")), { [container]: { other: { command: "keep" } }, user: 7 });
  });

  test("fx uninstall drops the context-mode entry from both containers", t => {
    const s = fxSandbox(t);
    writeFileSync(s.file, JSON.stringify({ mcp: { "context-mode": { command: "a" }, other: { command: "keep" } }, mcpServers: { "context-mode": { command: "b" } }, user: 7 }));
    const removed = runUninstall({ adapter: fxRow, env: s.env, project: { projectKey: "synthetic-fx" }, confirmDelete: false });
    assert.equal(removed.rows.filter(r => r.after === "removed").length, 2);
    assert.deepEqual(JSON.parse(readFileSync(s.file, "utf8")), { mcp: { other: { command: "keep" } }, mcpServers: {}, user: 7 });
  });

  test("fx fresh setup creates only its MCP and supported skills, and remove removes those files", async t => {
    const s = fxSandbox(t);
    const result = await runSetup({ ...s, runId: "fresh" });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const profile = JSON.parse(readFileSync(s.file, "utf8"));
    assert.equal(Object.keys(profile).join(), "mcpServers");
    assert.equal(profile.mcpServers["context-mode"][C.FX_OPERATION_TIMEOUT_FIELD], C.FX_OPERATION_TIMEOUT_MS);
    assert.equal(existsSync(path.join(s.fxHome, "hooks.json")), false);
    assert.equal(existsSync(path.join(s.fxHome, "settings.json")), false);
    assert.equal(runRemove(s).exitCode, 0);
    assert.equal(existsSync(s.file), false);
  });

  test("fx setup without CONTEXT_MODE_DATA_DIR writes no env map, so the server uses its default data root", async t => {
    const s = fxSandbox(t);
    delete s.env.CONTEXT_MODE_DATA_DIR;
    const result = await runSetup({ ...s, runId: "default-root" });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(s.file, "utf8")).mcpServers["context-mode"], "env"), false);
  });

  // A run without CONTEXT_MODE_DATA_DIR uses the default root, so the server must not keep an older one (split store).
  // An emptied environment map stays: fx reads environment whenever it is present, even empty.
  test("fx setup without CONTEXT_MODE_DATA_DIR removes an older data root and keeps the other keys", async t => {
    for (const field of ["env", "environment"]) {
      for (const keep of [false, true]) {
        const s = fxSandbox(t);
        const map = { CONTEXT_MODE_DATA_DIR: path.join(s.root, "older store"), ...(keep ? { KEEP: "yes" } : {}) };
        writeFileSync(s.file, JSON.stringify({ mcpServers: { "context-mode": { command: "old", args: [], [field]: map } } }));
        delete s.env.CONTEXT_MODE_DATA_DIR;
        const result = await runSetup({ ...s, runId: "default-root-again" });
        assert.equal(result.exitCode, 0, JSON.stringify(result));
        const entry = JSON.parse(readFileSync(s.file, "utf8")).mcpServers["context-mode"];
        assert.deepEqual(entry[field], keep ? { KEEP: "yes" } : field === "environment" ? {} : undefined, `${field} keep=${keep}`);
        assert.equal((await runDoctor(s)).exitCode, 0);
      }
    }
  });

  test("fx setup accepts an own entry fx starts: type stdio or local, enabled true", async t => {
    const s = fxSandbox(t);
    for (const own of [{ type: "stdio" }, { type: "local" }, { enabled: true }, { type: "stdio", enabled: true },
      { required: false, startup_timeout_ms: 1, restart_limit: 0 }, { required: true, startup_timeout_ms: 0xffff_ffff, restart_limit: 255 }]) {
      writeFileSync(s.file, JSON.stringify({ mcpServers: { "context-mode": { command: "old", ...own } } }));
      const result = await runSetup({ ...s, runId: "accepted" });
      assert.equal(result.exitCode, 0, JSON.stringify(own) + " " + JSON.stringify(result));
      const entry = JSON.parse(readFileSync(s.file, "utf8")).mcpServers["context-mode"];
      for (const [key, value] of Object.entries(own)) assert.equal(entry[key], value, key);
    }
  });

  // Every refusal names the file and its own Fix: line; setup again would refuse the same way (D-R54-OC-PLUGINS-DIR-1).
  test("fx refuses a profile or container that is not an object before any write, and names that file", async t => {
    const s = fxSandbox(t);
    for (const before of ["[]", '{"mcp":[]}', '{"mcpServers":null}', '{"mcp":"x","mcpServers":{}}']) {
      writeFileSync(s.file, before);
      const result = await runSetup({ ...s, runId: "bad-profile" });
      assert.equal(result.exitCode, 1, JSON.stringify(result));
      assert.equal(readFileSync(s.file, "utf8"), before);
      assert.equal(existsSync(path.join(s.fxHome, "skills", "ctx-doctor", "SKILL.md")), false);
      const agent = result.agents[0];
      assert.ok(agent.reason.includes(s.file), agent.reason);
      assert.equal(agent.fix, C.FX_PROFILE_FIX(s.file));
      const d3 = checkHostConfig(fxRow, s.env, s.home);
      assert.deepEqual({ status: d3.status, fix: d3.fixCommand }, { status: "FAIL", fix: C.FX_PROFILE_FIX(s.file) });
    }
    // fx rejects these too (a repeated key included), so the Fix: line names the file, not another setup run.
    for (const before of ["{broken", '{"mcp":{},"mcp":{}}', '{"mcpServers":{"other":{"command":"one","command":"two"}}}']) {
      writeFileSync(s.file, before);
      const result = await runSetup({ ...s, runId: "unparsed" });
      assert.equal(result.exitCode, 1);
      assert.equal(readFileSync(s.file, "utf8"), before);
      assert.equal(result.agents[0].fix, C.FX_PROFILE_FIX(s.file), JSON.stringify(result.agents[0]));
      const d3 = checkHostConfig(fxRow, s.env, s.home);
      assert.deepEqual({ status: d3.status, detail: d3.detail, fix: d3.fixCommand }, { status: "FAIL", detail: C.FX_CONFIG_PARSE(s.file), fix: C.FX_PROFILE_FIX(s.file) });
    }
  });

  test("fx refuses disabled, malformed and non-stdio own entries with a Fix: line for that entry, and doctor never reports those PASS", async t => {
    const s = fxSandbox(t);
    for (const [own, fix] of [
      [{ enabled: false }, C.FX_ENABLE_FIX], [{ enabled: "false" }, C.FX_ENABLE_FIX],
      [{ type: "http", url: "https://example.invalid/mcp" }, C.FX_CONFIG_REVIEW], [{ url: "https://example.invalid/mcp" }, C.FX_CONFIG_REVIEW],
      [{ env: { INVALID: 42 } }, C.FX_CONFIG_REVIEW],
      // fx skips the whole entry for these (fx src/core/mcp/project_config.zig parseServerEntry), even with no fx on PATH to say so.
      [{ required: "yes" }, f => C.FX_ENTRY_VALUE_FIX(f, "required")],
      [{ startup_timeout_ms: 0 }, f => C.FX_ENTRY_VALUE_FIX(f, "startup_timeout_ms")],
      [{ startup_timeout_ms: 1.5 }, f => C.FX_ENTRY_VALUE_FIX(f, "startup_timeout_ms")],
      [{ startup_timeout_ms: 2 ** 32 }, f => C.FX_ENTRY_VALUE_FIX(f, "startup_timeout_ms")],
      [{ restart_limit: 256 }, f => C.FX_ENTRY_VALUE_FIX(f, "restart_limit")],
      [{ restart_limit: "3" }, f => C.FX_ENTRY_VALUE_FIX(f, "restart_limit")],
    ]) {
      const before = JSON.stringify({ mcpServers: { "context-mode": { command: "old", ...own } } });
      writeFileSync(s.file, before);
      const result = await runSetup({ ...s, runId: "held" });
      assert.equal(result.exitCode, 1, JSON.stringify(result));
      assert.equal(readFileSync(s.file, "utf8"), before);
      assert.equal(existsSync(path.join(s.fxHome, "skills", "ctx-doctor", "SKILL.md")), false);
      const agent = result.agents[0];
      assert.ok(agent.reason.includes(s.file), agent.reason);
      assert.equal(agent.fix, fix(s.file));
      const d3 = checkHostConfig(fxRow, s.env, s.home);
      assert.deepEqual({ status: d3.status, fix: d3.fixCommand }, { status: "FAIL", fix: fix(s.file) });
    }
  });

  test("fx checks treat an fx on PATH that is not the coding agent as no fx and never run its list or show", async t => {
    const s = fxSandbox(t);
    const bin = s.bin;
    const calls = path.join(s.root, "calls.jsonl");
    fakeFx(bin, `import {appendFileSync} from 'node:fs';
const a=process.argv.slice(2); if (a.join(' ')==='mcp --help') { process.stdout.write('Usage: fx [flags] [code...]\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a)+'\\n'); process.stdout.write('{"servers":[]}');`);
    const result = await runSetup({ ...s, runId: "json-viewer" });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(pick(result.agents[0].checks.find(c => c.name === "native-mcp")), { ok: true, warn: true, detail: C.FX_NOT_AGENT });
    const d3 = asServer(s, () => checkHostConfig(fxRow, s.env, s.home));
    assert.deepEqual({ status: d3.status, detail: d3.detail }, { status: "WARN", detail: C.FX_NOT_AGENT });
    assert.equal(existsSync(calls), false, "no list or show on another program");
  });

  test("fx native acceptance checks the listed profile and tools, preserves errors, and rolls back failed installs", async t => {
    const s = fxSandbox(t);
    const bin = s.bin;
    const calls = path.join(s.root, "calls.jsonl");
    const response = path.join(s.root, "response.json");
    fakeFx(bin, `
import {appendFileSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2);
if (args.join(' ')==='mcp --help') { process.stdout.write(${JSON.stringify(FX_AGENT_HELP)}+'\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
const r=JSON.parse(readFileSync(${JSON.stringify(response)},'utf8'))[args[1]];
process.stdout.write(typeof r.body==='string'?r.body:JSON.stringify(r.body)); process.exit(r.exit??0);
`);
    const own = { name: "context-mode", source: "profile", file: s.file, transport: "stdio", status: "not_started", error: null };
    const ready = { ...own, status: "ready", tools: TOOL_ORDER.map(name => ({ name })) };
    const respond = (list, show = ready, exit = 0) => writeFileSync(response, JSON.stringify({ list: { body: list }, show: { body: show, exit } }));
    const recorded = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    // fx can exit zero while silently skipping our entry. A fresh setup must roll
    // back the MCP and skills it just wrote rather than report protocol-only PASS.
    respond({ servers: [] });
    const rejected = await runSetup({ ...s, runId: "native-skipped" });
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.agents[0].rolledBack, true);
    assert.equal(existsSync(s.file), false);
    assert.equal(existsSync(path.join(s.fxHome, "skills", "ctx-doctor", "SKILL.md")), false);
    assert.deepEqual(recorded(), [["mcp", "list", "--json"]]);
    assert.equal(rejected.agents[0].fix, C.FX_LIST_FIX(s.file), "the entry is gone after the rollback; the Fix: line still works");
    respond({ servers: [own] }, { ...ready, status: "error", error: "private-environment-value" });
    const unstarted = await runSetup({ ...s, runId: "native-unstarted" });
    assert.equal(unstarted.exitCode, 1);
    assert.equal(unstarted.agents[0].fix, C.FX_START_FIX(s.file));
    assert.equal(existsSync(s.file), false);
    respond({ servers: [own] });
    const accepted = await runSetup({ ...s, runId: "native-ready" });
    assert.equal(accepted.exitCode, 0, JSON.stringify(accepted));
    for (const name of ["mcp", "native-mcp"]) assert.equal(accepted.agents[0].checks.find(c => c.name === name).ok, true, name);
    assert.equal(accepted.agents[0].checks.find(c => c.name === "native-mcp").warn, undefined);
    assert.equal((await runDoctor(s)).exitCode, 0);
    assert.ok(recorded().some(args => JSON.stringify(args) === JSON.stringify(["mcp", "show", "context-mode", "--json"])));
    // fx mcp show waits up to 30 s for a server to start (fx src/core/mcp/mcp_contract.zig); doctor must wait longer.
    assert.ok(C.FX_SHOW_TIMEOUT_MS > 30_000);
    const before = readFileSync(s.file, "utf8");
    asServer(s, () => assert.equal(checkHostConfig(fxRow, s.env, s.home).status, "PASS"));
    for (const list of [
      { servers: [] },
      { servers: [{ ...own, source: "workspace" }] },
      { servers: [{ ...own, file: path.join(s.root, "different-profile", "mcp.json") }] },
      { servers: [{ ...own, transport: "http" }] },
      { servers: [{ ...own, status: "error", error: "private-environment-value" }] },
      { servers: [{ ...own, status: "disabled" }] },
      "malformed",
    ]) {
      respond(list); writeFileSync(calls, "");
      assert.equal((await runDoctor(s)).exitCode, 1);
      assert.equal(asServer(s, () => checkHostConfig(fxRow, s.env, s.home)).status, "FAIL");
      assert.ok(recorded().every(args => args[1] === "list"), "do not launch unaccepted or project entries");
      assert.equal(readFileSync(s.file, "utf8"), before);
    }
    for (const [show, exit] of [
      [{ ...ready, tools: [] }, 0],
      [{ ...ready, tools: [...ready.tools, ready.tools[0]] }, 0],
      [{ ...ready, source: "workspace" }, 0],
      [{ ...ready, status: "error", error: "private-environment-value" }, 0],
      [{ ...ready, status: "starting" }, 0],
      ["malformed", 0],
      ["private-environment-value", 1],
    ]) {
      respond({ servers: [own] }, show, exit);
      const doctor = await runDoctor(s);
      assert.equal(doctor.exitCode, 1);
      assert.equal(JSON.stringify(doctor).includes("private-environment-value"), false);
      assert.equal(readFileSync(s.file, "utf8"), before);
    }
    respond({ servers: [own] }); writeFileSync(calls, "");
    const mismatch = JSON.parse(before); mismatch.mcpServers["context-mode"].command = "unrelated-command";
    writeFileSync(s.file, JSON.stringify(mismatch));
    assert.equal((await runDoctor(s)).exitCode, 1);
    assert.equal(readFileSync(calls, "utf8"), "", "do not launch a mismatched configured command");
  });

  test("fx setup starts the entry through fx only after the server's own handshake passes", async t => {
    const s = fxSandbox(t);
    writeFileSync(path.join(s.pkgDir, "server.mjs"), "process.exit(3);\n");
    const bin = s.bin;
    const calls = path.join(s.root, "calls.jsonl");
    const own = { name: "context-mode", source: "profile", file: s.file, transport: "stdio", error: null };
    const list = { servers: [{ ...own, status: "not_started" }] };
    const ready = { ...own, status: "ready", tools: TOOL_ORDER.map(name => ({ name })) };
    fakeFx(bin, `import {appendFileSync} from 'node:fs';
const a=process.argv.slice(2); if (a.join(' ')==='mcp --help') { process.stdout.write(${JSON.stringify(FX_AGENT_HELP)}+'\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a)+'\\n');
process.stdout.write(a[1]==='list' ? ${JSON.stringify(JSON.stringify(list))} : ${JSON.stringify(JSON.stringify(ready))});`);
    const result = await runSetup({ ...s, runId: "handshake-first" });
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    const checks = result.agents[0].checks;
    assert.equal(checks.find(c => c.name === "mcp").ok, false);
    assert.deepEqual(pick(checks.find(c => c.name === "native-mcp")), { ok: false, warn: undefined, detail: C.FX_MCP_LAUNCH_SKIPPED });
    assert.equal(existsSync(calls), false, "fx never starts a server that fails its own handshake");
  });

  // fx mcp list fails when fx cannot read its profile (fx 0.0.16 rejects a UTF-8 BOM, for one; the fixture keeps one).
  // Setup rolls back, and the Fix: line points at that file and fx's own list command, not at setup again.
  test("fx setup and doctor name the profile when fx mcp list fails, instead of another setup run", async t => {
    const s = fxSandbox(t);
    const before = JSON.stringify({ mcpServers: { other: { command: "keep" } } }, null, 2).replace(/\n/g, "\r\n") + "\r\n";
    writeFileSync(s.file, before);
    const bin = s.bin;
    fakeFx(bin, `const a=process.argv.slice(2).join(' '); if (a==='mcp --help') { process.stdout.write(${JSON.stringify(FX_AGENT_HELP)}+'\\n'); process.exit(0); }
process.stderr.write("fx mcp: ~/.fx/mcp.json isn't valid JSON (private-environment-value)\\n"); process.exit(1);`);
    const result = await runSetup({ ...s, runId: "fx-unreadable" });
    assert.equal(result.exitCode, 1);
    const agent = result.agents[0];
    assert.equal(agent.rolledBack, true);
    assert.equal(readFileSync(s.file, "utf8"), before, "the profile keeps its bytes");
    assert.equal(agent.fix, C.FX_PROFILE_FIX(s.file));
    assert.equal(JSON.stringify(result).includes("private-environment-value"), false, "fx output is not echoed");
    writeFileSync(s.file, JSON.stringify({ mcpServers: { "context-mode": { command: process.execPath, args: launchArgs(s), [C.FX_OPERATION_TIMEOUT_FIELD]: C.FX_OPERATION_TIMEOUT_MS } } }));
    const d3 = asServer(s, () => checkHostConfig(fxRow, s.env, s.home));
    assert.deepEqual({ status: d3.status, fix: d3.fixCommand }, { status: "FAIL", fix: C.FX_PROFILE_FIX(s.file) });
    assert.equal(JSON.stringify(d3).includes("private-environment-value"), false);
  });

  test("fx refuses a profile fx cannot read as stored, a UTF-8 BOM or over 1 MiB, before any write, and doctor names the same fix", async t => {
    const s = fxSandbox(t);
    const big = JSON.stringify({ mcpServers: { other: { command: "keep", args: ["x".repeat(C.FX_PROFILE_MAX_BYTES)] } } });
    for (const [before, detail, fix] of [
      ["\uFEFF" + JSON.stringify({ mcpServers: { other: { command: "keep" } } }) + "\r\n", C.FX_CONFIG_BOM, C.FX_BOM_FIX],
      [big, C.FX_CONFIG_TOO_LARGE, C.FX_SIZE_FIX],
    ]) {
      writeFileSync(s.file, before);
      const result = await runSetup({ ...s, runId: "unreadable-bytes" });
      assert.equal(result.exitCode, 1, JSON.stringify(result).slice(0, 400));
      assert.equal(readFileSync(s.file, "utf8"), before, "the profile keeps its bytes");
      assert.equal(existsSync(path.join(s.fxHome, "skills", "ctx-doctor", "SKILL.md")), false);
      assert.equal(result.agents[0].fix, fix(s.file));
      const d3 = checkHostConfig(fxRow, s.env, s.home);
      assert.deepEqual({ status: d3.status, detail: d3.detail, fix: d3.fixCommand }, { status: "FAIL", detail: detail(s.file), fix: fix(s.file) });
    }
  });

  test("fx list and show run with the setup HOME and project dir, not the caller's", async t => {
    const s = fxSandbox(t);
    const project = path.join(s.root, "project"); mkdirSync(project);
    const log = path.join(s.root, "calls.jsonl");
    const own = { name: "context-mode", source: "profile", file: s.file, transport: "stdio", status: "not_started", error: null };
    const ready = { ...own, status: "ready", tools: TOOL_ORDER.map(name => ({ name })) };
    fakeFx(s.bin, `import { appendFileSync } from 'node:fs';
const a=process.argv.slice(2); if (a.join(' ')==='mcp --help') { process.stdout.write(${JSON.stringify(FX_AGENT_HELP)}+'\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ a, cwd: process.cwd(), home: process.env.HOME })+'\\n');
process.stdout.write(a[1]==='list' ? ${JSON.stringify(JSON.stringify({ servers: [own] }))} : ${JSON.stringify(JSON.stringify(ready))});`);
    assert.equal((await runSetup({ ...s, cwd: project, runId: "env-cwd" })).exitCode, 0);
    asServer(s, () => assert.equal(checkHostConfig(fxRow, s.env, project).status, "PASS"));
    const calls = readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.deepEqual(calls.map(c => c.a[1]), ["list", "show", "list"]);
    for (const c of calls) assert.deepEqual([realpathSync(c.cwd), c.home], [realpathSync(project), s.home]);
  });

  test("setup --print fx names the container the profile already uses", t => {
    const s = fxSandbox(t);
    for (const [profile, container] of [[undefined, "mcpServers"], ['{"mcpServers":{}}', "mcpServers"], ['{"mcp":{}}', "mcp"], ['{"mcp":{},"mcpServers":{}}', "mcp"], ["\uFEFF{\"mcp\":{}}\r\n", "mcp"], ["{broken", "mcpServers"]]) {
      if (profile === undefined) rmSync(s.file, { force: true }); else writeFileSync(s.file, profile);
      const step = printPlan(buildRegistry({ home: s.home, pkgDir: s.pkgDir, env: s.env }).find(r => r.id === "fx")).steps.find(x => x.kind === "config");
      assert.deepEqual(step.key, [container, "context-mode"], String(profile));
      assert.deepEqual(JSON.parse(step.block)[container]["context-mode"].args, launchArgs(s));
    }
  });

  test("fx accepts its entry when ~/.fx is a link, whether fx names the link or its target", { skip: process.platform === "win32" && "POSIX symlinks" }, async t => {
    const s = fxSandbox(t);
    const target = path.join(s.root, "dotfiles-fx");
    rmSync(s.fxHome, { recursive: true }); mkdirSync(target); symlinkSync(target, s.fxHome);
    for (const named of [s.file, path.join(realpathSync(target), "mcp.json")]) {
      const own = { name: "context-mode", source: "profile", file: named, transport: "stdio", status: "not_started", error: null };
      const ready = { ...own, status: "ready", tools: TOOL_ORDER.map(name => ({ name })) };
      fakeFx(s.bin, `const a=process.argv.slice(2).join(' '); if (a==='mcp --help') { process.stdout.write(${JSON.stringify(FX_AGENT_HELP)}+'\\n'); process.exit(0); }
process.stdout.write(a==='mcp list --json' ? ${JSON.stringify(JSON.stringify({ servers: [own] }))} : ${JSON.stringify(JSON.stringify(ready))});`);
      const result = await runSetup({ ...s, runId: "linked" });
      assert.equal(result.exitCode, 0, named + " " + JSON.stringify(result.agents[0]));
      const native = result.agents[0].checks.find(c => c.name === "native-mcp");
      assert.equal(native.warn, undefined, named + " " + JSON.stringify(native));
      assert.ok(lstatSync(s.fxHome).isSymbolicLink(), "the link stays");
      assert.ok(existsSync(path.join(target, "mcp.json")));
    }
  });

  test("fx config and backup stay private on POSIX, and remove puts the original mode back", { skip: process.platform === "win32" && "POSIX file modes" }, async t => {
    const { statSync } = await import("node:fs");
    const s = fxSandbox(t);
    writeFileSync(s.file, '{"mcpServers":{"other":{"command":"keep","env":{"SECRET":"synthetic"}}}}\n');
    chmodSync(s.file, 0o640);
    const result = await runSetup({ ...s, runId: "private" });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(statSync(s.file).mode & 0o777, 0o600);
    const manifest = JSON.parse(readFileSync(path.join(result.backupDir, "manifest.json"), "utf8"));
    for (const entry of manifest.entries.filter(e => e.backup)) assert.equal(statSync(path.join(result.backupDir, entry.backup)).mode & 0o777, 0o600);
    assert.equal(runRemove(s).exitCode, 0);
    assert.equal(statSync(s.file).mode & 0o777, 0o640);
  });
});
