# fx tool output benchmark

Both routes run the same command on a report of 180 tests. The compact case prints the counts and the three failures. The larger cases add 4, 8, 16, 64 or 256 KiB of diagnostic output around the answer. The session case runs four suites (`api`, `db`, `auth`, `billing`) one after another in one fx conversation, each with 64 KiB around its result line. A run passes when the JSON returned through fx contains the correct counts, test names and failure reasons for every suite.

Native fx uses `shell` and retrieves truncated output with `read_tool_result`. The MCP route discovers `ctx_execute` and searches the indexed source with `ctx_search` when needed. A deterministic loopback provider drives both routes, so the runs measure transport and tool output, not which tools a model picks.

## Run

From a source checkout on Linux or macOS (fx 0.0.16 has no Windows build) with Node 24.15 or newer, Git and the Vercel Labs fx CLI on PATH:

```sh
node build/build.mjs --out release-out
node --test --test-name-pattern "fx bench" tests/0012-live-harness.test.mjs
node bench/fx/run.mjs --fx "$(command -v fx)" --server "$PWD/release-out/server.mjs" --out /tmp/fx-benchmark-results --runs 5
```

## Measurements

Measured on 2026-11-13 with `release-out/server.mjs` built from this change on main b1541688: fx 0.0.16, Linux x86_64 (Ubuntu 24.04 under WSL 2), Node 24.15.0, 5 runs per case. Each run starts with a fresh profile; setup runs before the timed command. Tool text is the text of every tool result the provider received, each counted once; tool discovery is the part that `capability_search` and `mcp_select_tool` return, which lists tools, not command output. Request bytes are every request the provider received: the main turns, the permission review fx sends in `--auto` mode for each ctx tool call, and one title request. Wall time is the whole `fx ask` process: fx start, the MCP server start, the loopback round trips and local tool work, with no model inference. A cell is the median of the runs, followed by [min,max] when the runs differ.

| Output | Route | Correct | Tool text bytes | of it, tool discovery | Request JSON bytes | of it, permission reviews | Wall ms, median [min,max] |
|---|---|---:|---:|---:|---:|---:|---:|
| compact | native | 5/5 | 688 | 0 | 68734 | 5394 | 106 [100,128] |
| compact | cm | 5/5 | 5758 | 5367 | 130012 | 8585 | 355 [311,387] |
| 4k | native | 5/5 | 4836 | 0 | 72916 | 5394 | 103 [99,116] |
| 4k | cm | 5/5 | 9909 | 5367 | 134198 | 8585 | 348 [324,351] |
| 8k | native | 5/5 | 8984 | 0 | 77098 | 5394 | 105 [93,127] |
| 8k | cm | 5/5 | 14059 | 5367 | 138383 | 8585 | 355 [348,452] |
| 16k | native | 5/5 | 16793 | 0 | 133034 | 5394 | 122 [119,156] |
| 16k | cm | 5/5 | 13426 | 11964 | 255641 | 19208 | 430 [378,535] |
| 64k | native | 5/5 | 16793 | 0 | 133032 | 5394 | 143 [129,144] |
| 64k | cm | 5/5 | 13387 | 11964 | 255524 | 19182 | 428 [351,588] |
| 256k | native | 5/5 | 16793 | 0 | 133032 | 5394 | 149 [129,174] |
| 256k | cm | 5/5 | 13597 | 11964 | 256158 | 19323 | 438 [354,517] |
| session | native | 5/5 | 67126 | 0 | 662264 | 32730 | 362 [333,387] |
| session | cm | 5/5 | 17798 | 11964 | 713262 | 103622 | 693 [601,703] |

Without tool discovery, the MCP route returns 1,423 B of tool output at 64 KiB against 16,793 B, and 5,834 B against 67,126 B over the four-suite session. Discovery adds 11,964 B once per conversation: the two `capability_search` results. Up to 8 KiB both routes return the whole command output (OUTPUT_CAP is 16,384 B), so the MCP route only adds its one search (5,367 B).

Request bytes rise in every case. From 16 KiB on, most of the rise is the ctx tool schemas the searches load, sent again with every later request: the main requests are 235,784 against 127,080 B at 64 KiB. In the session the main requests are smaller with Context Mode (608,969 against 628,863 B); the rise is the permission reviews (103,622 against 32,730 B).

Over OUTPUT_CAP the `ctx_execute` reply is a preview whose head, whole chunks and pointer share a 4096 B budget (D-EXEC-PREVIEW-1). The chunk that holds the result line of this dense log does not fit, even with `intent:"RESULT"`, so the MCP route calls `ctx_search` next. Each run is a new `fx ask` with a fresh profile, so the MCP route always starts with `capability_search`.
