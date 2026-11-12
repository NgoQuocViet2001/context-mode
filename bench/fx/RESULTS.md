# Native fx A/B measurements

The tool plans are scripted. These measurements establish native executable/MCP transport behavior and fixture answer delivery; they do not establish autonomous model preference or billed token savings. See README.md for the full method and reproducible commands.

The native route already truncates large shell replies to 16,384 model-visible bytes. CM comparison includes discovery and MCP wrapper text. All byte counts below are UTF-8, not tokens. Main request bytes are normalized compact JSON bodies, including repeated history and advertised tool schemas.

| Task | Route | Oracle passes | Tool-result B | Main request B | Calls / model requests | Elapsed median [min, max] s |
| --- | --- | --- | ---: | ---: | ---: | --- |
| nplus1 | native-verbose | 5/5 | 16,384 | 81,942 | 1 / 2 | 0.157 [0.148, 0.190] |
| nplus1 | cm-verbose | 5/5 | 9,813 | 123,603 | 2 / 3 | 0.647 [0.451, 0.705] |
| nplus1 | native-compact | 5/5 | 539 | 62,555 | 1 / 2 | 0.140 [0.135, 0.165] |
| nplus1 | cm-compact | 5/5 | 5,594 | 118,440 | 2 / 3 | 0.717 [0.655, 0.807] |
| test_failures | native-verbose | 5/5 | 16,384 | 83,632 | 1 / 2 | 0.158 [0.147, 0.195] |
| test_failures | cm-verbose | 5/5 | 6,283 | 119,231 | 2 / 3 | 0.663 [0.635, 0.857] |
| test_failures | native-compact | 5/5 | 690 | 62,672 | 1 / 2 | 0.144 [0.141, 0.176] |
| test_failures | cm-compact | 5/5 | 5,745 | 118,520 | 2 / 3 | 0.671 [0.650, 0.905] |
| source_lookup | cm-verbose | 5/5 | 7,552 | 120,501 | 2 / 3 | 0.725 [0.671, 1.036] |
| source_lookup | native-compact | 5/5 | 556 | 62,526 | 1 / 2 | 0.165 [0.141, 0.185] |
| source_lookup | cm-compact | 5/5 | 5,611 | 118,386 | 2 / 3 | 0.728 [0.622, 1.379] |

Every cold run also made one actual native permission-review request and one title request to the local fixture. They are recorded separately. No usage numbers were supplied by the fixture, so fx reports null input/output token usage. No provider bill or monetary savings were observed.

The native verbose source probe initially lost the answer in its preview. The corrected policy reads the retained `full_output_handle` with `read_tool_result` and the literal query `RESULT`, without rerunning the command. The first five failed source rows remain in `final-runs` as harness omissions and are excluded from the corrected table.

Repeated corrected source runs are pending. `recovery-smoke` contains one successful actual native handle recovery, but is not substituted for a five-repetition row.

The same-session follow-up harness is prepared in `warm.py`. It is not reported as a pass until actual raw evidence exists.
