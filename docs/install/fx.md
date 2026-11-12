# Install context-mode v2 on fx

Vercel Labs' fx can call Context Mode through MCP. Use a build that lists `fx` in `context-mode setup --list`. The published Context Mode 2.1.8 predates this integration.

To try this branch before release, run the following from the checkout with Node 24.15 or later. Keep the built directory in place while fx uses the server.

```sh
npm install
npm run build:release
node release-out/cli.mjs setup --agents fx
fx mcp show context-mode
```

## Install

```sh
npm i -g context-mode
context-mode setup --agents fx
```

Update an installed release with the following command.

```sh
context-mode upgrade
```

Start a new fx session after setup. For a noninteractive installation, use `context-mode setup --yes --agents fx`.

Check: `context-mode doctor`

For manual setup, `context-mode setup --print fx` shows the config and file locations. Setup registers its stdio server in `~/.fx/mcp.json` and installs the skills under `~/.fx/skills`. fx 0.0.16 uses the current user's home even when `FX_HOME` is set.

## Verify

```sh
fx mcp show context-mode
context-mode doctor --agents fx
```

To try a real lookup, open fx in a project containing a test log and ask:

> Use Context Mode to index test.log, find the first failing test and quote the assertion that failed.

fx discovers MCP tools on demand. Context Mode can execute a command or search a stored result when fx calls its tools. Native fx file reads and shell commands follow fx's own output handling.

For follow-up searches, use the source ID printed by `ctx_index`, such as `s1`. This also works for a file whose name differs from the label you would use for pasted text. The [fx benchmarks](../../bench/fx/RESULTS.md) include the cost of discovering MCP tools.

## Remove

```sh
context-mode setup --remove --agents fx
```

Setup removal restores the saved files from every recorded setup in the same Context Mode data directory, including runs for other agents. It also restores their earlier contents if you have edited them since setup. To disconnect only the server in fx, run `fx mcp remove context-mode`; the three installed skill files remain available.

## Host support

fx v0.0.16 distributes native binaries for Linux and macOS. From Windows, run fx, Node and Context Mode in the same WSL environment. Keep the fx profile on the Linux filesystem so fx can enforce its private directory permissions.

The Linux x86_64 CLI was tested with Node 24.15, disposable user profiles and a local model fixture. All nine MCP tools were invoked. The host-config and MCP checks passed. Doctor warns that fx lacks an external hook channel, so it cannot automatically intercept native outputs or restore context after compaction. The version check can report unknown for an unpublished development build.
