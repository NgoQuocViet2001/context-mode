# Native fx and Context Mode transport benchmark

This harness runs the official native fx executable against a deterministic HTTP server bound to `127.0.0.1`. It uses no real model, provider credentials, Gateway service, SDK embedding or host substitution. Tool calls are scripted deliberately. Final answers are parsed from the actual tool results fx sends back to the fake endpoint and compared with fixture oracles stored outside the fx workspace.

The measurements prove transport behavior, output retention, MCP usability and answer delivery for the selected plans. They do not measure whether a real model independently chooses those plans, production answer quality, billed tokens, cache behavior or subscription savings.

## Runtime

- Official fx `0.0.16`, Linux x86_64 archive from `https://releases.fx.sh/v0.0.16/fx-linux-x86_64.tar.gz`.
- Archive SHA256: `f0fb822c7be546c80bcc89d50521bc1454435e0c6f586e8420c4e2b84fa80599`.
- Linux Node `24.15.0`, official `node-v24.15.0-linux-x64.tar.xz`; archive SHA256 `472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6`.
- Context Mode candidate is a local source build, not a published release. The captured `candidate-bundle/server.mjs` SHA256 is `51481ebda23e84194bc08891475aa44cd4500873bae258ca9dfa4733a3a7639e`. It contains the draft fx adapter.
- No source files in either application were changed by these harnesses. The integration changes belong to a separate workstream.
- Test HOME and project directories are created with `tempfile` on the Linux filesystem. On the tested Windows host, placing private fx state on `/mnt/d` fails because private-state permissions cannot be enforced. Workspace artifacts may remain on that mount.
- Child environment is an allowlist with a synthetic loopback-only key. Existing personal home directories, provider credentials and normal host configuration are not loaded or changed. fx remains in `auto` permission mode; its real review traffic is answered by the local fixture and counted separately.

## Reproduce

Requirements: Linux, Python 3, Git, Bash, the official fx binary and a built Context Mode server with the fx adapter. Node 24.15.0 or later is required by Context Mode. Keep private HOME on a filesystem that supports Unix private permissions.

```sh
python3 bench.py \
  --fx /path/to/fx \
  --node /path/to/node \
  --cm-server /path/to/context-mode/server.mjs \
  --out results \
  --repetitions 5

python3 warm.py \
  --fx /path/to/fx \
  --node /path/to/node \
  --cm-server /path/to/context-mode/server.mjs \
  --out warm-results \
  --repetitions 3
```

On Windows, launch these commands inside WSL. Running them directly with Windows Python cannot execute the Linux binary. Arguments use explicit paths, so neither script depends on a developer home directory or checkout location.

## Cold workload design

Each task has two output policies and two routes:

| Policy | Native fx | Context Mode |
| --- | --- | --- |
| Verbose diagnostic probe | Native `shell` runs `python3 analyze.py --verbose`. | `capability_search` discovers `ctx_execute`, then it runs the identical command with `intent:"RESULT"`. |
| Compact control | Native `shell` runs `python3 analyze.py`. | `ctx_execute` runs the identical compact command, with no intent. |

The source fixture is generated, and its analysis code is supplied in advance. The verbose script prints its input three times before the concise result, so this policy is intentionally an output-heavy diagnostic probe. It must not be presented as a natural autonomous workflow. The compact control demonstrates how printing only the answer already avoids most output bytes without Context Mode.

Three questions exercise different data:

- N+1: determine the worst request, repeated-query count, total query duration and overall query count from 109 query records.
- Test failures: determine exact pass/fail counts and three failing test/reason pairs among 180 test records.
- Source lookup: locate `compute_retry_delay` in 48 generated modules and report its source path, base delay and cap.

The native route uses fx's retained command output if truncation hides `RESULT`: `read_tool_result` with the real `full_output_handle` and literal query `RESULT`. This is a retrieval call, not a rerun of the diagnostic command.

For every repetition, each route gets a fresh HOME, project, CM data directory and fx session. Route order reverses on even repetitions. File generation and local oracle verification happen outside the measured `fx ask` interval. Local server shutdown also occurs outside that interval. No model inference delay is simulated.

## Warm follow-up design

`warm.py` runs six separate real `fx ask` calls, continuing the same fx session using `--resume`. The file contains 6,000 synthetic event records. Each turn asks for one distinct event's exact endpoint, HTTP status, latency and release. Oracles are held outside the fx workspace.

The native control uses `grep_files` with the event ID, an exact file path and zero context lines. The CM route indexes the file once with `ctx_index`, then uses `ctx_search` for each event ID. MCP discovery happens only when the actual outgoing fx schema lacks the required tool. This allows the measurement to expose whether selection/discovery survives real process resume rather than assuming it does.

These are separate CLI processes continuing one saved fx session. Startup time is included on every turn. The tested CM search defaults to worktree scope, with the explicit `activity-log` source. Successful retrieval establishes retained source content in that worktree; it does not establish fx-to-MCP session-ID propagation or automatic session hooks.

This is a fair precise-lookup control: fx does not have to dump or reread the entire file. CM can return neighboring indexed chunks, whereas native literal grep can return one matching line. Neither route is forced to produce a large raw reply. Tools are still selected by the harness policy, not by a real model.

## Metrics and interpretation

- `unique_tool_result_text_bytes`: UTF-8 bytes in each distinct model-visible tool-result value, counted once per call. Includes native JSON wrappers, MCP wrappers and discovery output. It is not the hidden command stdout size.
- `unique_tool_result_json_bytes`: serialized UTF-8 bytes for those complete tool-result records, including JSON escaping and metadata.
- `main_request_json_bytes`: sum of compact JSON request bodies actually received by the local endpoint for main-agent calls. Includes repeated history, system messages and advertised schemas. It is not a token count, cache miss count or bill.
- Review and title requests are recorded separately and excluded from main-request bytes. Raw `requests.json` preserves them for inspection.
- `wall_seconds`: elapsed time around the native `fx ask` subprocess, including fx startup, actual command/MCP execution and loopback request handling. No real model inference or network latency is included.
- Raw stdout size is recorded independently. fx already bounds native output, so comparing raw stdout directly against CM visible output would overstate the benefit.
- Provider usage is left null when absent. Observed cost is null. No bytes-to-token conversion or dollar estimate is invented.

Each run retains raw requests, tool calls, model-visible tool results, stdout/stderr, fixture data, oracle and metrics. Summaries report medians and min/max ranges. `bench.py` and `warm.py` can be copied without runtime archives or private context to support a PR or an independent reproduction.

## Preserved corrections

The directories `smoke`, `smoke-v2`, and `smoke-v3` contain harness corrections, not fx/CM product failures: first the policy did not decode fx's native JSON wrapper, then it used the newer source tree's `toolbox` API against the stable binary, then it omitted MCP wrapper decoding. `smoke-v4` validated all four N+1 routes.

`final-runs` initially omitted native retained-output recovery. Its five verbose source-lookup answers are invalid as a complete comparison, and are retained for audit. `recovery-smoke` proves the fixed native handle path. Corrected repeated source rows, when available, belong under `recovery-runs`; they replace only the five invalid source rows in the final aggregate, leaving the other 55 measured rows unchanged.
