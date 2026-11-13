# ADR-0026: fx as an MCP client with no hook channel

- Status: Proposed (2026-11-12). Pending owner decision.
- Amends, if accepted: ADR-0020 (one row with no hook channel).
- Keeps: ADR-0020 for the ten accepted hosts, ADR-0010 (doctor is the verifier), ADR-0019 (setup engine), ADR-0023 (fx has no install command that takes a package, so setup is the install path, as for Kiro), ADR-0024 (one test file per area: `tests/0026-fx-mcp-client.test.mjs`).
- Deviation row: D-FX-MCP-1.

## Context

fx 0.0.16 (vercel-labs/fx; Linux and macOS builds only) is a coding agent CLI. It loads stdio MCP servers from `~/.fx/mcp.json` and skills from `~/.fx/skills/<name>/SKILL.md`. The fx sources named below are at tag v0.0.16 (481104fd).

ADR-0020 requires a hook channel on every agent. fx has none a package can use:

- fx defines a PreToolUse event (`src/core/hooks/definitions.zig`) and takes handlers only from code compiled into fx (`registerPreToolUse` in `src/core/hooks/runtime.zig`); at v0.0.16 only fx's own tests register one. No config file or CLI flag adds a command hook.
- Observer hooks need an application that embeds fx. `sdk/semantic-observer-hooks.md`: "The standalone CLI doesn't install an observer sink."

Other fx behaviour that shapes the integration:

- The tools of a profile server reach the model only after `capability_search` or `mcp_select_tool` (`src/builtins/tools.zig`). Always-loaded tools apply only to servers an ACP client passes in (`_meta.fx.alwaysLoaded`, `src/acp/mcp_servers.zig`).
- fx gives a server 30 s to start and cancels a call that sends nothing for 60 s (`src/core/mcp/mcp_contract.zig`); a call also ends at 600 s unless `operation_timeout_ms` is larger (`src/mcp/core/request.zig`, `src/core/mcp_host/config.zig`). `ctx_execute` runs up to 600 s and answers once, at the end.
- fx reads `mcp`, or `mcpServers` when there is no `mcp`. In an entry, `environment` wins over `env`. fx skips an entry with a `required` value that is not a boolean, or a `startup_timeout_ms` or `restart_limit` out of range (`src/core/mcp/project_config.zig`). It reads at most 1 MiB of the profile, as stored, so a UTF-8 BOM fails (`src/builtins/mcp.zig`).
- A stdio server gets only HOME, LOGNAME, PATH, SHELL, TERM, USER and the entry's own env (`src/core/mcp_host/config.zig` `inherited_names`).
- The skill field `disable-model-invocation` is not read: the model sees all three skills.

## Decision

1. `fx` is appended to `AGENT_IDS` as an MCP client. Its row has hook channel `none`, an empty event map and compaction delivery `none`. The ten accepted rows are unchanged: `tests/_lib/hook-hosts.mjs` pins them, and every check that allows `none` asserts the row is fx.
2. Setup writes the `context-mode` stdio entry into the container fx reads, with `operation_timeout_ms: 630000` (EXEC_TIMEOUT_MS plus 30 s, so a run that hits its own limit still sends its reply; an owned field, like zcode's `timeoutMs`), and the three skills to `~/.fx/skills`. The data root of the setup run goes into the env map fx reads; a run without `CONTEXT_MODE_DATA_DIR` removes an older one, so the server and the CLI share the default root. Other fields and servers stay.
3. Setup refuses an entry it would have to override (disabled, not stdio, a `url` with no `type`, an env value that is not a string, a `required`, `startup_timeout_ms` or `restart_limit` value fx skips the entry for), a profile or container that is not an object, and a profile fx cannot read (invalid JSON, a repeated key, a UTF-8 BOM, over 1 MiB). Each refusal names the file and its own Fix: line, never another setup run.
4. Setup and doctor check the entry through fx. `fx mcp list --json` must list the entry from that profile as a stdio server that is not started, then `fx mcp show context-mode --json` must report it ready with the nine tools. Without the fx coding agent on PATH both checks are WARN. The three hook checks are WARN.
5. Detection: a `~/.fx` folder, or an fx on PATH whose `fx mcp --help` is the coding agent's. On Windows, where fx has no build, only the folder counts and no fx is run.

## Measured

`bench/fx/run.mjs`: fx 0.0.16, Linux x86_64 (Ubuntu 24.04 under WSL 2), Node 24.15.0, a scripted loopback provider, 5 runs per case, every run correct.

| Case | Native: tool text / request bytes | Context Mode: tool text (of it, tool discovery) / request bytes |
|---|---:|---:|
| compact | 688 / 68,734 | 5,758 (5,367) / 130,012 |
| 8 KiB | 8,984 / 77,098 | 14,059 (5,367) / 138,383 |
| 64 KiB | 16,793 / 133,032 | 13,387 (11,964) / 255,524 |
| four suites in one session | 67,126 / 662,264 | 17,798 (11,964) / 713,262 |

Above OUTPUT_CAP the command output that reaches the model falls (16,793 to 1,423 B at 64 KiB; 67,126 to 5,834 B over the session). Tool discovery costs 5,367 to 11,964 B once per conversation, and the schemas it loads go out with every later request, so request bytes rise in every case. In the session the main requests are smaller (608,969 against 628,863 B) and the rise is fx's permission review of each ctx call (103,622 against 32,730 B). Wall time, the whole `fx ask` with fx and server start: 143 against 428 ms at 64 KiB and 362 against 693 ms over the session (median of 5). A scripted provider drives both routes, so these runs do not show which tools a model picks.

## Consequences

- fx users get the ctx tools, the store and the three skills.
- Large native shell and file output is not redirected or replaced, and nothing is injected at compaction.
- No native tool event reaches the store: hook-seen stays WARN, and only ctx_* calls write to it.
- The model has to find and pick the ctx tools itself.

## Alternatives

- Keep fx out until it has a hook a package can register (ADR-0020 as it is).
- Document a manual `fx mcp add` only, with no registry row, setup or doctor support.
