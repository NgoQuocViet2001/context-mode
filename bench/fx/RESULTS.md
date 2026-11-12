# Native fx and Context Mode measurements

Context Mode reduced verbose diagnostic replies. It did not improve this benchmark's compact-output or precise-lookup controls: native fx already caps large replies, retains their full output and offers small literal searches. MCP discovery and repeated schema loading add overhead. These are byte and transport measurements with scripted tool plans, not evidence of billed token savings or autonomous model preference.

The official native fx 0.0.16 executable made the real shell, file and MCP calls. A deterministic server on `127.0.0.1` supplied the tool plans. Final answers were extracted from actual model-visible replies and compared with external fixture oracles. No real model or provider credentials were used. Usage and billed cost remain null.

## Final candidate: Linux guest

Final Context Mode server SHA256: `b040434f7d5d4b8dbf30d12e01633a1ff0382330703bdf6c1fb714e76144f9ce`. The artifact package is `0.0.0-dev`, built from the source package version 2.1.8 with the draft fx integration.

Environment: Debian 12 x86_64, kernel 6.1.0-54-amd64, Python 3.11.2, Node 24.15.0, Git 2.39.5, portable QEMU TCG. All paired timings below come from this same guest. They include local tool work and process startup, with no model inference delay. TCG timings cannot establish production latency and are not combined with WSL timings.

### Verbose source lookup, five repetitions per route

The same generated 48-module fixture and analysis command produced 96,070 bytes. Native fx's initial bounded preview omitted the final result; `read_tool_result` recovered it through the actual retained-output handle and literal `RESULT` query. The command was not rerun. CM used `ctx_execute` with the same command and `intent:"RESULT"`.

| Route | Oracle passes | Unique tool-result B | Main request JSON B | Tools / model requests | Elapsed median [min, max] s |
| --- | --- | ---: | ---: | ---: | --- |
| Native, retained-output recovery | 5/5 | 16,681 | 129,268 | 2 / 3 | 1.412 [1.318, 2.273] |
| CM, intent-selected output | 5/5 | 7,552 | 120,444 | 2 / 3 | 8.197 [6.988, 8.556] |

CM returned 54.7% fewer tool-result bytes and 6.8% fewer normalized main-request bytes in this particular recovery case. It took longer in this guest. Byte deltas are not token or money deltas.

A final N+1 smoke also passed both routes, one run each: native 16,384 tool-result B / 81,904 main-request B; CM 9,813 B / 123,546 B. It confirms final-artifact execution, without replacing the repeated exploratory measurements below.

### Six real resumed turns, three conversations per route

The same 947,566-byte log contains 6,000 synthetic events. Each turn asks for one distinct event's endpoint, HTTP status, latency and release. Native uses one precise `grep_files` call. CM indexes the file once, then searches its exact returned path label. Searches use the current default worktree scope.

Each `fx ask --resume` starts a new CLI process continuing the same saved fx session. In these observed runs, CM needed discovery on every resumed turn: six discovery calls, one index call and six searches. This tests actual resume behavior, not an assumed same-process cache. It does not establish automatic hooks or fx-to-MCP session-ID propagation.

Bytes, calls and timing are medians per six-turn conversation. Pass counts cover all 18 prompts.

| Route | Strict final answers | Visible-field answers | Tool-result B | Main request JSON B | Tools / model requests | Elapsed median [min, max] s |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Native literal grep | 18/18 | 18/18 | 1,272 | 405,826 | 6 / 12 | 1.614 [1.449, 2.146] |
| CM index/search | 15/18 | 18/18 | 43,819 | 1,149,765 | 13 / 19 | 44.396 [44.073, 45.245] |

In each CM conversation the final `EVENT05783` record was clipped after `"status": 503`, omitting its closing brace. The literal event, endpoint `/accounts`, latency `1107`, release `r3` and HTTP status `503` were all present in the same record. The strict JSON policy therefore emitted `NO_VERIFIED_RESULT` on those three turns. Those observed final-answer failures remain unchanged.

The separate offline `verify_fields.py` checks complete literal fields from one returned record before comparing with the oracle. It fills no missing field, adds no brace and rejects ambiguous values. It confirms 18/18 visible-field associations for each route. This distinguishes human-useful information from complete machine-parseable records; it does not retroactively make the three strict answers pass.

For these known IDs, native literal grep was smaller. CM's index and neighboring context did not pay off, even after multiple follow-ups. A different task needing broad semantic retrieval could behave differently and was not measured here.

Ancillary final-guest checks, excluded from benchmark counts: setup, repeat setup, doctor and removal exited zero; private configuration permissions passed. Real native fx calls exercised all nine CM tools across two disposable scenarios, with positive output and preservation checks. Doctor correctly warns that fx has no external hook channel, so explicit MCP use does not provide native-tool interception or automatic session continuity.

## Exploratory WSL matrix: earlier draft

This separate matrix used an earlier unpublished server build, SHA256 `51481ebda23e84194bc08891475aa44cd4500873bae258ca9dfa4733a3a7639e`, with official fx 0.0.16 under WSL2 Ubuntu 24.04. Each row has five repetitions. It is retained as exploratory data, not substituted for the final guest artifact or merged into its timing ranges.

The verbose policy intentionally printed its inputs three times before the answer. The compact control ran the identical analysis without raw traces. Fixture files were hash-identical across all 20 generated variants of each task.

| Task | Route | Oracle passes | Tool-result B | Main request JSON B | Elapsed median [min, max] s |
| --- | --- | --- | ---: | ---: | --- |
| N+1 | Native verbose | 5/5 | 16,384 | 81,942 | 0.157 [0.148, 0.190] |
| N+1 | CM verbose + intent | 5/5 | 9,813 | 123,603 | 0.647 [0.451, 0.705] |
| N+1 | Native compact | 5/5 | 539 | 62,555 | 0.140 [0.135, 0.165] |
| N+1 | CM compact | 5/5 | 5,594 | 118,440 | 0.717 [0.655, 0.807] |
| Test failures | Native verbose | 5/5 | 16,384 | 83,632 | 0.158 [0.147, 0.195] |
| Test failures | CM verbose + intent | 5/5 | 6,283 | 119,231 | 0.663 [0.635, 0.857] |
| Test failures | Native compact | 5/5 | 690 | 62,672 | 0.144 [0.141, 0.176] |
| Test failures | CM compact | 5/5 | 5,745 | 118,520 | 0.671 [0.650, 0.905] |
| Source lookup | CM verbose + intent | 5/5 | 7,552 | 120,501 | 0.725 [0.671, 1.036] |
| Source lookup | Native compact | 5/5 | 556 | 62,526 | 0.165 [0.141, 0.185] |
| Source lookup | CM compact | 5/5 | 5,611 | 118,386 | 0.728 [0.622, 1.379] |

Native verbose N+1 and test-failure runs used one tool call and two model requests. CM cold runs used two tools and three model requests. Every cold run additionally made one local permission-review and one title request, recorded separately.

Five original native verbose-source rows are excluded because the first policy omitted retained-output recovery. One corrected WSL smoke passed; the five paired final-artifact guest repetitions above provide the repeated recovery comparison. Later WSL `E_UNEXPECTED` launch failures were treated as an environment outage, not a product failure.

## Measurement boundaries

Tool-result bytes count UTF-8 model-visible values once per call, including native JSON wrappers, MCP wrappers and discovery replies. They are not hidden raw stdout bytes. Main-request bytes are normalized compact JSON including repeated history, system text and tool schemas, excluding title and permission-review side requests. No tokenizer, caching or billing conversion is applied.

Plans are scripted; fixtures and analysis code are supplied in advance. No real-model reasoning, autonomous tool choice, production latency or fx 0.0.16-versus-0.0.15 uncached-token claim is evaluated. Neither environment was CPU-pinned. Earlier wrapper/API/source-label harness errors and the genuine clipped-record limitation were retained rather than relabeled as product bugs or silently removed.

`README.md` gives runnable commands. `results.json` contains version/fixture hashes, environment-separated summaries, ranges, pass counts and limitations. Synthetic raw evidence is retained by the test operator; it is not required to run the supplied harnesses.
