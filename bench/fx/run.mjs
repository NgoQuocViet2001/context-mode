#!/usr/bin/env node
// Real fx CLI and MCP tools, driven by a deterministic loopback protocol fixture.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL = "fixture/transport-v1";
export const CASES = ["compact", "4k", "8k", "16k", "64k", "256k", "session"];
// "session": one fx conversation runs four suites in turn, each printing 64 KiB around its result line.
export const SUITES = ["api", "db", "auth", "billing"];
const SESSION_PADDING = 64 * 1024;
const bytes = (s) => Buffer.byteLength(s);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const json = (p, value) => writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
// fx loads the tools of a profile server through these two builtins; their results list tools, not command output.
const DISCOVERY_TOOLS = new Set(["capability_search", "mcp_select_tool"]);

export function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (!value || typeof value !== "object") return "";
  return ["text", "value", "content", "output"].filter((k) => k in value).map((k) => textOf(value[k])).join("\n");
}
export function toolResults(body) {
  const results = new Map();
  function visit(v) {
    if (!v || typeof v !== "object") return;
    if (v.type === "tool-result") results.set(v.toolCallId, v);
    for (const child of Object.values(v)) visit(child);
  }
  visit(body.prompt ?? body.messages ?? []);
  return results;
}
export function semanticText(output) {
  const text = textOf(output);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.output_delta === "string") return parsed.output_delta;
    if (parsed.result) return textOf(parsed.result);
  } catch { /* plain tool output */ }
  return text;
}
export function answerIn(results, suite = null) {
  for (const result of [...results.values()].reverse()) {
    for (const match of semanticText(result.output).matchAll(/RESULT (\{[^\n]*\})/g)) {
      let parsed;
      try { parsed = JSON.parse(match[1]); } catch { continue; /* incomplete excerpt */ }
      if (suite === null || parsed.suite === suite) return parsed;
    }
  }
  return null;
}
/** Tool text split into command output and tool discovery, and request bytes per request kind. */
export function costs(results, requests) {
  const tool = { output: 0, discovery: 0 }, request = { main: 0, permission: 0, title: 0 };
  for (const result of results.values()) tool[DISCOVERY_TOOLS.has(result.toolName) ? "discovery" : "output"] += bytes(textOf(result.output));
  for (const r of requests) request[r.kind] += r.bytes;
  return { outputBytes: tool.output, discoveryBytes: tool.discovery, mainBytes: request.main, permissionBytes: request.permission, titleBytes: request.title };
}
export function searchSource(results) {
  for (const result of [...results.values()].reverse()) {
    const match = semanticText(result.output).match(/ctx_search\(\{[^\n]*?source:("(?:[^"\\]|\\.)*")/);
    if (match) return JSON.parse(match[1]);
  }
  return null;
}
export function recovery(results) {
  for (const result of [...results.values()].reverse()) {
    if (result.toolName !== "shell") continue;
    const shell = JSON.parse(textOf(result.output));
    if (shell.state === "running" && shell.session_id)
      return ["shell", { action: "interact", session_id: shell.session_id, yield_time_ms: 30000 }];
    if (shell.exit_code !== 0) throw new Error("native shell did not finish successfully");
    if (shell.output_truncated && shell.full_output_handle)
      return ["read_tool_result", { handle: shell.full_output_handle, query: "RESULT" }];
  }
  throw new Error("answer absent and no recoverable native output");
}

const REASONS = ["expected 204 got 500", "timeout after 1500ms", "expected 3 rows got 4", "token expired", "lock wait timeout"];

// One report of 180 tests and its analyzer. `suite` names the report in the input file, the script and the result line.
function report(project, padding, suite, failing) {
  const name = suite === null ? "" : "-" + suite;
  // Oracle and analyzer use different computations; the transport driver gets neither.
  const rows = Array.from({ length: 180 }, (_, i) => ({
    test: `case_${String(i).padStart(3, "0")}`,
    status: failing.includes(i) ? "failed" : "passed",
    reason: failing.includes(i) ? REASONS[failing.indexOf(i) % REASONS.length] : "",
  }));
  const failures = failing.map((i, n) => ({ test: `case_${String(i).padStart(3, "0")}`, reason: REASONS[n % REASONS.length] }));
  const expected = { ...(suite === null ? {} : { suite }), total: 180, passed: 180 - failing.length, failed: failing.length, failures };
  json(path.join(project, `input${name}.json`), rows);
  const script = `import { readFileSync } from 'node:fs';
const rows = JSON.parse(readFileSync('input${name}.json', 'utf8'));
const bad = rows.filter(r => r.status === 'failed');
const answer = {${suite === null ? "" : `suite: ${JSON.stringify(suite)}, `}total: rows.length, passed: rows.filter(r => r.status === 'passed').length,
  failed: bad.length, failures: bad.map(({test,reason}) => ({test,reason}))};
const line = 'TRACE diagnostic detail ' + 'x'.repeat(96) + '\\n';
const trace = line.repeat(Math.ceil(${padding} / 2 / line.length));
process.stdout.write(trace + 'RESULT ' + JSON.stringify(answer) + '\\n' + trace);
`;
  writeFileSync(path.join(project, `analyze${name}.mjs`), script);
  return { expected, command: `node analyze${name}.mjs`, suite };
}

/** The commands of one case and the answer the final JSON must equal. */
export function fixture(project, size) {
  mkdirSync(project, { recursive: true });
  if (size === "session") {
    const parts = SUITES.map((suite, n) => report(project, SESSION_PADDING, suite, [17 + n, 81 + 2 * n, 123 + 3 * n].slice(0, 2 + (n % 2))));
    return { expected: { suites: parts.map((p) => p.expected) }, commands: parts.map(({ command, suite }) => ({ command, suite })) };
  }
  const one = report(project, size === "compact" ? 0 : Number.parseInt(size) * 1024, null, [17, 81, 123]);
  return { expected: one.expected, commands: [{ command: one.command, suite: null }] };
}

export function promptFor(size) {
  if (size !== "session") return "Analyze input.json with node analyze.mjs. Report total, passed, failed and every failing test with its exact reason as JSON.";
  return `Run ${SUITES.map((s) => `node analyze-${s}.mjs`).join(", ")} in that order. For each suite report its name, total, passed, failed and every failing test with its exact reason, as JSON {"suites":[...]}.`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
const finish = (answer) => [
  { type: "text-delta", id: "answer", delta: JSON.stringify(answer) },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" } },
];

// The commands run in order; each one ends when its result line is in a tool result the model has seen.
async function driver(route, commands) {
  const state = { requests: [], outputs: new Map(), calls: [], errors: [] };
  let current = 0, discovered = false, searchDiscovered = false;
  const executed = new Set(), searched = new Set();
  const answerFor = (i) => answerIn(state.outputs, commands[i].suite);
  function call(name, input, side = false) {
    const id = side ? "permission-review" : `call_${state.calls.length + 1}`;
    if (!side) state.calls.push({ name, input });
    return [{ type: "tool-call", toolCallId: id, toolName: name, input },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" } }];
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: MODEL, type: "language", tags: ["tool-use"], context_window: 200000 }] }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks), body = JSON.parse(raw);
      const encoded = raw.toString();
      const kind = encoded.includes('"permission_decision"') ? "permission" : encoded.includes("Generate a short title") ? "title" : "main";
      state.requests.push({ kind, bytes: raw.length, body });
      let events;
      if (kind === "permission") events = call("permission_decision", { risk: "low", decision: "clear", rationale: "Read-only generated benchmark fixture." }, true);
      else if (kind === "title") events = finish("Generated test report");
      else {
        for (const [id, value] of toolResults(body)) state.outputs.set(id, value);
        if (state.calls.length >= 6 * commands.length) throw new Error("tool call limit exceeded");
        while (current < commands.length && answerFor(current)) current++;
        const command = commands[current]?.command;
        if (current === commands.length) {
          events = finish(commands.length === 1 ? answerFor(0) : { suites: commands.map((_, i) => answerFor(i)) });
        } else if (route === "native" && !executed.has(current)) {
          executed.add(current);
          events = call("shell", { action: "run", command, yield_time_ms: 30000 });
        } else if (route === "native") events = call(...recovery(state.outputs));
        else if (!discovered) {
          discovered = true;
          events = call("capability_search", { query: "ctx_execute run shell code", server: "context-mode" });
        } else if (!executed.has(current)) {
          const names = (body.tools ?? []).map((t) => t.name).filter((name) => name.endsWith("_ctx_execute"));
          if (names.length !== 1) throw new Error("ctx_execute not discovered uniquely");
          executed.add(current);
          events = call(names[0], { language: "shell", code: command, intent: "RESULT" });
        } else if (!searchDiscovered && searchSource(state.outputs)) {
          searchDiscovered = true;
          events = call("capability_search", { query: "ctx_search", server: "context-mode" });
        } else if (!searched.has(current) && searchSource(state.outputs)) {
          const names = (body.tools ?? []).map((t) => t.name).filter((name) => name.endsWith("_ctx_search"));
          if (names.length !== 1) throw new Error("ctx_search not discovered uniquely");
          searched.add(current);
          events = call(names[0], { queries: ["RESULT"], source: searchSource(state.outputs) });
        } else throw new Error("CM reply omitted the complete answer after retained-output search");
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
    } catch (error) {
      state.errors.push(error.message);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(finish({ fixtureError: error.message }).map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function sample(options, size, route, repetition) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "fx-output-bench-"));
  const home = path.join(scratch, "home"), project = path.join(scratch, "project");
  mkdirSync(home, { mode: 0o700 });
  const { expected, commands } = fixture(project, size);
  execFileSync("git", ["init", "-q", project]);
  const model = await driver(route, commands);
  const evidence = path.join(options.out, `${size}-${route}-${repetition}`);
  mkdirSync(evidence, { recursive: true });
  const env = { HOME: home, USER: "fixture", LOGNAME: "fixture", SHELL: "/bin/bash",
    PATH: `${path.dirname(options.node)}:${path.dirname(options.fx)}:/usr/bin:/bin`,
    LANG: "C.UTF-8", NO_COLOR: "1", TERM: "dumb", FX_AUTO_UPGRADE: "0",
    AI_GATEWAY_API_KEY: "loopback-fixture-only", FX_MODEL: MODEL,
    FX_GATEWAY_BASE_URL: model.url, FX_GATEWAY_CHAT_URL: `${model.url}/v4/ai/language-model`,
    FX_TEST_GATEWAY_CHAT_URL: `${model.url}/v4/ai/language-model`, FX_PERMISSION_MODE: "auto",
    CONTEXT_MODE_DATA_DIR: path.join(scratch, "cm-data") };
  try {
    let setupMs = 0;
    if (route === "cm") {
      const start = performance.now();
      const installed = await run(options.node, [path.join(path.dirname(options.server), "cli.mjs"), "setup", "--agents", "fx", "--yes", "--json"], { cwd: project, env, timeout: 90000 });
      setupMs = performance.now() - start;
      json(path.join(evidence, "setup.json"), installed);
      if (installed.code !== 0) throw new Error("CM setup failed");
      const entry = JSON.parse(readFileSync(path.join(home, ".fx", "mcp.json"), "utf8")).mcpServers["context-mode"];
      if (JSON.stringify(entry.args) !== JSON.stringify([options.server, "--agent", "fx"]) || entry.env?.CONTEXT_MODE_DATA_DIR !== env.CONTEXT_MODE_DATA_DIR)
        throw new Error("installer registered a different candidate or data directory");
    }
    const start = performance.now();
    const output = await run(options.fx, ["ask", "--json", "--auto", "--model", MODEL, promptFor(size)], { cwd: project, env, timeout: 180000 });
    const wallMs = performance.now() - start;
    json(path.join(evidence, "process.json"), output);
    json(path.join(evidence, "requests.json"), model.state.requests);
    let final = null, hostModel = null;
    try { const parsed = JSON.parse(output.stdout); final = JSON.parse(parsed.final_output); hostModel = parsed.model; } catch { /* failed run */ }
    const requests = model.state.requests;
    const row = { size, route, repetition, pass: output.code === 0 && hostModel === MODEL && !model.state.errors.length && JSON.stringify(final) === JSON.stringify(expected),
      wallMs, setupMs, toolBytes: [...model.state.outputs.values()].reduce((n, r) => n + bytes(textOf(r.output)), 0),
      requestBytes: requests.reduce((n, r) => n + r.bytes, 0), ...costs(model.state.outputs, requests), mainRequests: requests.filter((r) => r.kind === "main").length,
      sideRequests: requests.filter((r) => r.kind !== "main").length, calls: model.state.calls.map((c) => c.name), errors: model.state.errors,
      inputSha256: commands.map((c) => hash(path.join(project, `input${c.suite === null ? "" : "-" + c.suite}.json`))).join(","),
      scriptSha256: commands.map((c) => hash(path.join(project, c.command.split(" ")[1]))).join(",") };
    json(path.join(evidence, "metrics.json"), row);
    return row;
  } finally {
    await model.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return { median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, min: sorted[0], max: sorted.at(-1) };
}
/** Median of the runs; the range follows when the runs differ (a native shell result carries its duration). */
export function cell(values) {
  const { median, min, max } = stats(values);
  return min === max ? String(Math.round(median)) : `${Math.round(median)} [${Math.round(min)},${Math.round(max)}]`;
}
export function table(rows) {
  const lines = ["| Output | Route | Correct | Tool text bytes | of it, tool discovery | Request JSON bytes | of it, permission reviews | Wall ms, median [min,max] |", "|---|---|---:|---:|---:|---:|---:|---:|"];
  for (const size of CASES) for (const route of ["native", "cm"]) {
    const group = rows.filter((r) => r.size === size && r.route === route);
    if (!group.length) continue;
    const wall = stats(group.map((r) => r.wallMs)), of = (key) => cell(group.map((r) => r[key]));
    lines.push(`| ${size} | ${route} | ${group.filter((r) => r.pass).length}/${group.length} | ${of("toolBytes")} | ${of("discoveryBytes")} | ${of("requestBytes")} | ${of("permissionBytes")} | ${Math.round(wall.median)} [${Math.round(wall.min)},${Math.round(wall.max)}] |`);
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2), get = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  if (args.includes("--help")) {
    console.log(`node bench/fx/run.mjs --fx /path/to/fx --server /path/to/release-out/server.mjs --out /tmp/fx-results [--runs 3] [--cases ${CASES.join(",")}]`); return;
  }
  const options = { fx: path.resolve(get("--fx", "fx")), node: process.execPath, server: path.resolve(get("--server", "release-out/server.mjs")), out: get("--out"), runs: Number(get("--runs", "3")) };
  if (!options.out || !Number.isInteger(options.runs) || options.runs < 1) throw new Error("--out and a positive integer --runs are required");
  options.out = path.resolve(options.out);
  const cases = get("--cases", CASES.join(",")).split(",");
  if (cases.some((size) => !CASES.includes(size))) throw new Error("unknown output size");
  mkdirSync(options.out, { recursive: true });
  const pins = { date: new Date().toISOString(), fx: execFileSync(options.fx, ["--version"], { encoding: "utf8" }).trim(), node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, fixtureModel: MODEL,
    fxSha256: hash(options.fx), nodeSha256: hash(options.node), serverSha256: hash(options.server), cliSha256: hash(path.join(path.dirname(options.server), "cli.mjs")), runnerSha256: hash(fileURLToPath(import.meta.url)) };
  json(path.join(options.out, "pins.json"), pins);
  const rows = [];
  for (let repetition = 1; repetition <= options.runs; repetition++) for (const size of cases)
    for (const route of repetition % 2 ? ["native", "cm"] : ["cm", "native"]) {
      const row = await sample(options, size, route, repetition);
      rows.push(row);
      json(path.join(options.out, "metrics.json"), rows);
      console.log(`${row.pass ? "ok" : "FAIL"} ${size} ${route} ${repetition}`);
    }
  writeFileSync(path.join(options.out, "table.md"), table(rows) + "\n");
  console.log("\n" + table(rows));
  if (rows.some((row) => !row.pass)) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exitCode = 1; });
