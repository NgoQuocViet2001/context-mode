#!/usr/bin/env python3
"""Synthetic, deterministic native fx transport benchmark. No paid model involved."""

import argparse, collections, hashlib, http.server, json, os, pathlib, re, shutil, statistics, subprocess, tempfile, threading, time


def dump(path, value):
    pathlib.Path(path).write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    )


def text_of(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(text_of(v) for v in value)
    if isinstance(value, dict):
        if value.get("type") in ("text", "json", "error-text"):
            return text_of(value.get("value", value.get("text", "")))
        return "\n".join(
            text_of(v)
            for k, v in value.items()
            if k in ("text", "value", "content", "output")
        )
    return ""


def results(body):
    found = {}

    def visit(v):
        if isinstance(v, dict):
            if v.get("type") == "tool-result":
                found[v["toolCallId"]] = v
            for x in v.values():
                visit(x)
        elif isinstance(v, list):
            for x in v:
                visit(x)

    visit(body.get("prompt", body.get("messages", [])))
    return found


def semantic_text(value):
    text = text_of(value)
    try:
        obj = json.loads(text)
        if isinstance(obj, dict) and "output_delta" in obj:
            return obj["output_delta"]
        if isinstance(obj, dict) and "result" in obj:
            return text_of(obj["result"])
    except Exception:
        pass
    return text


def make_fixture(project, task):
    project.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    if task == "nplus1":
        rows = []
        for request, count in [("alpha", 41), ("beta", 1), ("gamma", 67)]:
            rows += [
                {
                    "request": request,
                    "query": "SELECT child WHERE parent_id=?",
                    "duration_ms": 3 + (i % 5),
                    "seq": i,
                }
                for i in range(count)
            ]
        (project / "input.json").write_text(json.dumps(rows))
        oracle = {
            "worst_request": "gamma",
            "queries": 67,
            "query_ms": sum(3 + i % 5 for i in range(67)),
            "total_queries": 109,
        }
        body = """rows=json.load(open('input.json')); c={}; t={}
for r in rows: c[r['request']]=c.get(r['request'],0)+1; t[r['request']]=t.get(r['request'],0)+r['duration_ms']
worst=max(c,key=c.get)
answer=dict(worst_request=worst,queries=c[worst],query_ms=t[worst],total_queries=len(rows))"""
        question = "Find the request with the largest repeated query count, its query duration total and the overall query count."
    elif task == "test_failures":
        rows = [
            {
                "test": "case_%03d" % i,
                "status": "failed" if i in (17, 81, 123) else "passed",
                "reason": {
                    17: "expected 204 got 500",
                    81: "timeout after 1500ms",
                    123: "expected 3 rows got 4",
                }.get(i, ""),
            }
            for i in range(180)
        ]
        (project / "input.json").write_text(json.dumps(rows))
        oracle = {
            "passed": 177,
            "failed": 3,
            "failures": [
                {"test": r["test"], "reason": r["reason"]}
                for r in rows
                if r["status"] == "failed"
            ],
        }
        body = """rows=json.load(open('input.json')); bad=[r for r in rows if r['status']=='failed']
answer=dict(passed=len(rows)-len(bad),failed=len(bad),failures=[dict(test=r['test'],reason=r['reason']) for r in bad])"""
        question = (
            "Report passed/failed counts and each failing test with its exact reason."
        )
    else:
        src = project / "src"
        src.mkdir()
        for i in range(48):
            (src / ("module_%02d.py" % i)).write_text(
                "# Synthetic module\n"
                + "\n".join(
                    "def helper_%d_%d(): return %d" % (i, j, j) for j in range(20)
                )
                + "\n"
                + (
                    "def compute_retry_delay(attempt):\n    return min(250 * 2 ** attempt, 8000)\n"
                    if i == 31
                    else ""
                )
            )
        oracle = {
            "path": "src/module_31.py",
            "function": "compute_retry_delay",
            "base_ms": 250,
            "cap_ms": 8000,
        }
        body = """rows=[]; answer=None
for p in sorted(pathlib.Path('src').glob('*.py')):
 s=p.read_text(); rows.append(dict(path=str(p),source=s))
 if 'def compute_retry_delay(' in s:
  match=re.search(r'min\\((\\d+) \\* 2 \\*\\* attempt, (\\d+)\\)',s)
  answer=dict(path=str(p),function='compute_retry_delay',base_ms=int(match[1]),cap_ms=int(match[2]))"""
        question = "Locate compute_retry_delay and report its source path, base delay and maximum delay."
    script = (
        "import json, pathlib, re, sys\n"
        + body
        + "\nif '--verbose' in sys.argv:\n for cycle in range(3):\n  for row in rows: print('TRACE '+json.dumps(row,sort_keys=True))\nprint('RESULT '+json.dumps(answer,sort_keys=True))\n"
    )
    (project / "analyze.py").write_text(script)
    actual = subprocess.check_output(["python3", "analyze.py"], cwd=project, text=True)
    if json.loads(actual.split("RESULT ")[-1]) != oracle:
        raise AssertionError("independent fixture oracle mismatch")
    return oracle, question


class LocalModel:
    def __init__(self, route, command, intent):
        self.route, self.command, self.intent = route, command, intent
        self.requests = []
        self.main = []
        self.side = []
        self.calls = []
        self.outputs = {}
        self.stage = 0
        self.final = None
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                data = {
                    "data": [
                        {
                            "id": "openai/gpt-5",
                            "type": "language",
                            "tags": ["tool-use"],
                            "context_window": 200000,
                        }
                    ]
                }
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode())

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("content-length", 0)))
                body = json.loads(raw)
                owner.requests.append(
                    {"path": self.path, "body": body, "at": time.perf_counter()}
                )
                encoded = raw.decode()
                if '"permission_decision"' in encoded:
                    owner.side.append({"kind": "permission", "body": body})
                    events = owner.tool(
                        "permission_decision",
                        dict(
                            risk="low",
                            decision="clear",
                            rationale="Synthetic fixture read and local analysis only.",
                        ),
                        "review",
                        False,
                    )
                elif "Generate a short title" in encoded:
                    owner.side.append({"kind": "title", "body": body})
                    events = [
                        {
                            "type": "finish",
                            "finishReason": {"unified": "stop", "raw": "stop"},
                        }
                    ]
                else:
                    owner.main.append(body)
                    owner.current = body
                    for cid, v in results(body).items():
                        owner.outputs[cid] = v
                    events = owner.next()
                wire = (
                    "".join("data: " + json.dumps(x) + "\n\n" for x in events)
                    + "data: [DONE]\n\n"
                )
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(wire.encode())))
                self.end_headers()
                self.wfile.write(wire.encode())

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def tool(self, name, args, cid=None, record=True):
        cid = cid or "call_" + str(len(self.calls) + 1)
        if record:
            self.calls.append(
                dict(id=cid, name=name, args=args, at=time.perf_counter())
            )
        return [
            {"type": "tool-call", "toolCallId": cid, "toolName": name, "input": args},
            {
                "type": "finish",
                "finishReason": {"unified": "tool-calls", "raw": "tool-calls"},
            },
        ]

    def next(self):
        if self.stage == 0:
            self.stage += 1
            if self.route.startswith("cm"):
                return self.tool(
                    "capability_search",
                    dict(query="ctx_execute run shell code", server="context-mode"),
                )
            return self.tool(
                "shell", dict(action="run", command=self.command, yield_time_ms=30000)
            )
        if self.stage == 1 and self.route.startswith("cm"):
            self.stage += 1
            names = [
                x.get("name", "")
                for x in self.current.get("tools", [])
                if x.get("name", "").endswith("_ctx_execute")
            ]
            if names:
                return self.tool(
                    names[0],
                    dict(
                        language="shell",
                        code=self.command,
                        intent=self.intent if "verbose" in self.route else "",
                    ),
                )
        visible = "\n".join(
            semantic_text(v.get("output")) for v in self.outputs.values()
        )
        matches = re.findall(r"RESULT (\{[^\n]*\})", visible)
        for match in reversed(matches):
            try:
                self.final = json.loads(match)
                break
            except Exception:
                pass
        if self.final is None and len(self.calls) < 5:
            for output in reversed(list(self.outputs.values())):
                try:
                    shell = json.loads(text_of(output.get("output")))
                    if shell.get("full_output_handle") and shell.get(
                        "output_truncated"
                    ):
                        return self.tool(
                            "read_tool_result",
                            dict(handle=shell["full_output_handle"], query="RESULT"),
                        )
                except Exception:
                    pass
            handles = re.findall(
                r"(?:handle[=:\s]+|read_tool_result[^\n]*?)([a-zA-Z0-9_-]{8,})", visible
            )
            if handles:
                return self.tool(
                    "read_tool_result", dict(handle=handles[-1], query="RESULT")
                )
        answer = (
            json.dumps(self.final, sort_keys=True)
            if self.final is not None
            else "NO_VERIFIED_RESULT"
        )
        return [
            {"type": "text-delta", "id": "answer", "delta": answer},
            {"type": "finish", "finishReason": {"unified": "stop", "raw": "stop"}},
        ]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def run_one(args, root, task, route, rep):
    name = f"{task}-{route}-{rep}"
    evidence = root / name
    evidence.mkdir()
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="fx-benchmark-"))
    os.chmod(scratch, 0o700)
    home = scratch / "home"
    home.mkdir(mode=0o700)
    (home / ".fx").mkdir(mode=0o700)
    project = scratch / "project"
    oracle, question = make_fixture(project, task)
    dump(evidence / "oracle.json", oracle)
    command = "python3 analyze.py" + (" --verbose" if route.endswith("verbose") else "")
    model = LocalModel(route, command, "RESULT")
    env = {
        "HOME": str(home),
        "USER": "fixture",
        "LOGNAME": "fixture",
        "SHELL": "/bin/bash",
        "PATH": str(pathlib.Path(args.node).parent) + ":/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "NO_COLOR": "1",
        "TERM": "dumb",
        "AI_GATEWAY_API_KEY": "synthetic-loopback-only",
        "FX_AUTO_UPGRADE": "0",
        "FX_MODEL": "openai/gpt-5",
        "FX_GATEWAY_BASE_URL": model.url,
        "FX_GATEWAY_CHAT_URL": model.url + "/v4/ai/language-model",
        "FX_TEST_GATEWAY_CHAT_URL": model.url + "/v4/ai/language-model",
        "FX_PERMISSION_MODE": "auto",
        "CONTEXT_MODE_DATA_DIR": str(scratch / "cm-data"),
    }
    if route.startswith("cm"):
        dump(
            home / ".fx" / "mcp.json",
            {
                "mcpServers": {
                    "context-mode": {
                        "command": args.node,
                        "args": [args.cm_server, "--agent", "fx"],
                        "env": {"CONTEXT_MODE_DATA_DIR": str(scratch / "cm-data")},
                        "enabled": True,
                    }
                }
            },
        )
    started = time.perf_counter()
    try:
        p = subprocess.run(
            [args.fx, "ask", "--json", "--auto", "--model", "openai/gpt-5", question],
            env=env,
            cwd=project,
            capture_output=True,
            text=True,
            timeout=args.timeout,
        )
        elapsed = time.perf_counter() - started
        (evidence / "stdout.json").write_text(p.stdout)
        (evidence / "stderr.txt").write_text(p.stderr)
        try:
            output = json.loads(p.stdout)
        except Exception:
            output = {}
        try:
            final = json.loads(output.get("final_output", ""))
        except Exception:
            final = None
        metrics = {
            "task": task,
            "route": route,
            "repetition": rep,
            "exit_code": p.returncode,
            "wall_seconds": elapsed,
            "oracle_pass": final == oracle,
            "final": final,
            "model_requests": len(model.main),
            "review_requests": sum(x["kind"] == "permission" for x in model.side),
            "title_requests": sum(x["kind"] == "title" for x in model.side),
            "tool_calls": len(model.calls),
            "unique_tool_result_text_bytes": sum(
                len(text_of(v.get("output")).encode()) for v in model.outputs.values()
            ),
            "unique_tool_result_json_bytes": sum(
                len(json.dumps(v, ensure_ascii=False, separators=(",", ":")).encode())
                for v in model.outputs.values()
            ),
            "main_request_json_bytes": sum(
                len(json.dumps(v, ensure_ascii=False, separators=(",", ":")).encode())
                for v in model.main
            ),
            "usage": output.get("usage"),
            "observed_cost_usd": None,
            "fixture_raw_output_bytes": len(
                subprocess.check_output(
                    ["python3", "analyze.py", "--verbose"], cwd=project
                )
            ),
        }
        dump(evidence / "metrics.json", metrics)
        dump(evidence / "requests.json", model.requests)
        dump(evidence / "calls.json", model.calls)
        dump(evidence / "tool-results.json", model.outputs)
        shutil.copytree(
            project, evidence / "fixture", ignore=shutil.ignore_patterns(".git")
        )
        return metrics
    except Exception as error:
        dump(
            evidence / "error.json",
            {"error": repr(error), "requests": model.requests, "calls": model.calls},
        )
        raise
    finally:
        model.close()
        shutil.rmtree(scratch)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--fx", required=True)
    p.add_argument("--node", default="/usr/bin/node")
    p.add_argument("--cm-server")
    p.add_argument("--out", default="results")
    p.add_argument("--repetitions", type=int, default=3)
    p.add_argument("--timeout", type=int, default=90)
    p.add_argument(
        "--tasks", nargs="+", default=["nplus1", "test_failures", "source_lookup"]
    )
    p.add_argument(
        "--routes",
        nargs="+",
        default=["native-verbose", "native-compact", "cm-verbose", "cm-compact"],
    )
    args = p.parse_args()
    if any(x.startswith("cm") for x in args.routes) and not args.cm_server:
        p.error("--cm-server required for CM routes")
    root = pathlib.Path(args.out).resolve()
    root.mkdir(parents=True, exist_ok=True)
    all_metrics = []
    for rep in range(1, args.repetitions + 1):
        for task in args.tasks:
            for route in (args.routes if rep % 2 else list(reversed(args.routes))):
                r = run_one(args, root, task, route, rep)
                all_metrics.append(r)
                print(json.dumps(r), flush=True)
                dump(root / "all-metrics.json", all_metrics)
    summary = []
    for task in args.tasks:
        for route in args.routes:
            rows = [r for r in all_metrics if r["task"] == task and r["route"] == route]
            item = {
                "task": task,
                "route": route,
                "passes": sum(r["oracle_pass"] for r in rows),
                "runs": len(rows),
            }
            for key in (
                "wall_seconds",
                "unique_tool_result_text_bytes",
                "unique_tool_result_json_bytes",
                "main_request_json_bytes",
                "model_requests",
                "tool_calls",
                "review_requests",
            ):
                values = [r[key] for r in rows]
                item[key] = {
                    "median": statistics.median(values),
                    "min": min(values),
                    "max": max(values),
                }
            summary.append(item)
    dump(root / "summary.json", summary)


if __name__ == "__main__":
    main()
