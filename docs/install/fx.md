# Install context-mode v2 on fx

## Install

```sh
npm i -g context-mode
context-mode setup --agents fx
```

Update:

```sh
context-mode upgrade
```

Check: `context-mode doctor`

fx has no install command that takes a package, so setup is the install path here. `npm i -g context-mode` also gives the `context-mode` command for doctor.

With no terminal (a script or CI), add `--yes`: `context-mode setup --yes --agents fx`. Without it, setup stops with exit 2.

Start a new fx session after setup.

To do the setup step by hand, run `context-mode setup --print fx` and follow what it prints.

## What setup changes

- Adds the `context-mode` entry to `~/.fx/mcp.json`: under `mcp` when the file has it, else under `mcpServers`. Other servers and keys stay. The entry sets `operation_timeout_ms` to 630000, 30 s above the `ctx_execute` limit, so fx waits for a long run (the fx 0.0.16 default is 60000).
- Sets `CONTEXT_MODE_DATA_DIR` in the entry's env map when setup runs with it, and removes it when setup runs without it, so the server and the `context-mode` command use the same data folder.
- Writes the skills `/ctx-doctor`, `/ctx-stats` and `/ctx-upgrade` to `~/.fx/skills/<name>/SKILL.md`.
- Writes no hooks: fx has no hook a package can register ([ADR-0027](../architecture/adr/0027-fx-mcp-client.md), proposed). The output of fx's own `shell`, `read_file` and `grep_files` tools reaches the model as fx returns it.
- Backs up each file first. A failed step is rolled back byte for byte. Setup writes the profile and its backup with owner-only access (0600), as fx does; remove puts the old mode back.
- Never edits `AGENTS.md` or other instruction files.

## Verify

```sh
fx mcp show context-mode
context-mode doctor --agents fx
```

`fx mcp show` lists the server as ready with nine tools. Doctor checks the entry through `fx mcp list` and `fx mcp show` when fx is on PATH, and shows the three hook rows as WARN.

## Remove

```sh
context-mode setup --remove --agents fx
```

It puts each touched file back as it was before setup, so a server added to `~/.fx/mcp.json` after setup (with `fx mcp add`, for one) goes too. `fx mcp remove context-mode` removes only the server entry and keeps the three skill files; fx refuses it when the file has both `mcp` and `mcpServers`. To remove the package too, see [Uninstall](./README.md#uninstall).

## Known limits

- fx 0.0.16 ships Linux and macOS builds only. On Windows, run fx and context-mode inside WSL. On Windows, `context-mode setup` finds fx only by a `~/.fx` folder and never runs an `fx` from PATH.
- fx 0.0.16 loads the tools of a profile server on demand: the model calls `capability_search` or `mcp_select_tool` before its first ctx tool call. That adds request bytes ([fx benchmark](../../bench/fx/README.md)).
- No hook, so nothing redirects or replaces a large `shell`, `read_file` or `grep_files` result, and nothing is injected at compaction. The model picks `ctx_execute` on its own, and the fx system prompt says a listed server is not a reason to use MCP.
- fx passes only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER` to the server, plus the entry's env map (`environment`, or `env` when there is no `environment`). A command run through `ctx_execute` sees those, `PWD` and the color settings `ctx_execute` adds. Add any other variable to that map.
- fx does not read `disable-model-invocation` in a skill file, so the model can call the three skills on its own.
- fx reads `~/.fx/mcp.json` as stored: up to 1 MiB, and a file that starts with a UTF-8 byte order mark fails. fx also skips an entry whose `required`, `startup_timeout_ms` or `restart_limit` value it does not accept. Setup refuses these before any write, with or without fx on PATH, and the `Fix:` line names the file.

## Report a problem

Run `context-mode doctor --agents fx`. A failed check prints a `gh issue create` command and a report file under `~/.context-mode/reports/`. Open the [v2 bug form](https://github.com/mksglu/context-mode/issues/new?template=bug.yml) and paste the report.

## Verified

Tested on Linux x86_64 (Ubuntu 24.04 under WSL 2), Node 24.15.0, fx 0.0.16 (`fx-linux-x86_64.tar.gz`, sha256 f0fb822c7be546c80bcc89d50521bc1454435e0c6f586e8420c4e2b84fa80599), a clean temporary HOME, a `release-out` build of this change on main `b1541688`.

| Command | fx version | Date | Result |
|---|---|---|---|
| `context-mode setup --yes --agents fx` | 0.0.16 | 2026-11-13 | Pass: `~/.fx/mcp.json` written (0600, `operation_timeout_ms` 630000), three skills, `native-mcp` passed through fx |
| `context-mode setup --yes --agents fx` (second run) | 0.0.16 | 2026-11-13 | Pass, no change |
| `context-mode doctor --agents fx` | 0.0.16 | 2026-11-13 | Pass (hook rows WARN) |
| `fx mcp show context-mode` | 0.0.16 | 2026-11-13 | ready, 9 tools |
| `ctx_execute` running `sleep 75` through `fx ask` | 0.0.16 | 2026-11-13 | Pass: output returned after 75 s |
| `context-mode setup --yes --agents fx` with an `mcp` profile, and with both `mcp` and `mcpServers` | 0.0.16 | 2026-11-13 | Pass: entry under `mcp`, fx reports it ready |
| `context-mode setup --yes --agents fx` with `"enabled": false` on the entry | 0.0.16 | 2026-11-13 | Refused, file unchanged, `Fix:` names the file |
| `context-mode setup --yes --agents fx` with a profile that starts with a UTF-8 BOM | 0.0.16 | 2026-11-13 | Refused, file unchanged; `fx mcp list` fails on the same file |
| `context-mode setup --yes --agents fx` with `"restart_limit": 300` on the entry | 0.0.16 | 2026-11-13 | Refused, file unchanged; `fx mcp list` skips that entry |
| `context-mode setup --remove --yes --agents fx` | 0.0.16 | 2026-11-13 | Pass: each profile restored byte for byte |

fx has no Windows build, so no Windows run.
