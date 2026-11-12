#!/usr/bin/env python3
"""Six real fx ask/resume turns: precise native grep versus indexed MCP search."""

import argparse, hashlib, json, os, pathlib, shutil, statistics, subprocess, tempfile, time
from bench import LocalModel, dump, semantic_text, text_of


class WarmModel(LocalModel):
    def next(self):
        if len(self.calls) - self.turn_call_start > 8:
            return [
                {"type": "text-delta", "id": "answer", "delta": "HARNESS_TOOL_LIMIT"},
                {"type": "finish", "finishReason": {"unified": "stop", "raw": "stop"}},
            ]
        available = {x.get("name", "") for x in self.current.get("tools", [])}
        if self.route == "native" and not self.looked:
            self.looked = True
            return self.tool(
                "grep_files",
                dict(
                    pattern=self.event,
                    path="activity.log",
                    mode="matches",
                    head_limit=5,
                    context_lines=0,
                ),
            )
        if self.route == "cm":
            kind = "ctx_index" if self.need_index else "ctx_search"
            exact = [n for n in available if n.endswith("_" + kind)]
            if not self.looked or self.need_index:
                if not exact:
                    return self.tool(
                        "capability_search", dict(query=kind, server="context-mode")
                    )
                if self.need_index:
                    self.need_index = False
                    return self.tool(
                        exact[0], dict(path="activity.log", source="activity-log")
                    )
                self.looked = True
                return self.tool(
                    exact[0], dict(queries=[self.event], source="activity-log")
                )
        final = None
        for output in self.outputs.values():
            text = semantic_text(output.get("output"))
            todo = [text]
            while todo:
                item = todo.pop()
                if isinstance(item, dict):
                    if item.get("event") == self.event:
                        final = {
                            k: item[k]
                            for k in (
                                "event",
                                "endpoint",
                                "status",
                                "latency_ms",
                                "release",
                            )
                        }
                    todo.extend(item.values())
                elif isinstance(item, list):
                    todo.extend(item)
                elif isinstance(item, str):
                    for match in __import__("re").finditer(r"\{", item):
                        try:
                            value, end = json.JSONDecoder().raw_decode(
                                item[match.start() :]
                            )
                            if isinstance(value, (dict, list)):
                                todo.append(value)
                        except Exception:
                            pass
        self.final = final
        answer = (
            json.dumps(final, sort_keys=True)
            if final is not None
            else "NO_VERIFIED_RESULT"
        )
        return [
            {"type": "text-delta", "id": "answer", "delta": answer},
            {"type": "finish", "finishReason": {"unified": "stop", "raw": "stop"}},
        ]


def run(args, out, route, rep):
    evidence = out / f"{route}-{rep}"
    evidence.mkdir()
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="fx-warm-"))
    os.chmod(scratch, 0o700)
    project = scratch / "project"
    project.mkdir()
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    home = scratch / "home"
    home.mkdir(mode=0o700)
    (home / ".fx").mkdir(mode=0o700)
    targets = [137, 923, 1741, 2893, 4201, 5783]
    rows = [
        dict(
            event="EVENT%05d" % i,
            endpoint=["/orders", "/invoices", "/accounts"][i % 3],
            status=[200, 204, 500, 503][i % 4],
            latency_ms=11 + (i * 37) % 1703,
            release="r%d" % (i % 17),
            detail="Synthetic unrelated operational details " + str(i),
        )
        for i in range(6000)
    ]
    (project / "activity.log").write_text(
        "\n".join(json.dumps(r, sort_keys=True) for r in rows) + "\n"
    )
    oracle = [
        {
            k: rows[i][k]
            for k in ("event", "endpoint", "status", "latency_ms", "release")
        }
        for i in targets
    ]
    dump(evidence / "oracle.json", oracle)
    model = WarmModel(route, "", "")
    model.need_index = route == "cm"
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
    if route == "cm":
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
    turns = []
    session = None
    try:
        for turn, expected in enumerate(oracle):
            model.event = expected["event"]
            model.looked = False
            model.final = None
            model.turn_call_start = len(model.calls)
            before_calls = len(model.calls)
            before_main = len(model.main)
            before_outputs = set(model.outputs)
            prompt = (
                "In activity.log, report event "
                + model.event
                + " endpoint, status, latency_ms and release."
            )
            argv = (
                [args.fx, "ask", "--json", "--auto", "--model", "openai/gpt-5"]
                + (["--resume", session] if session else [])
                + [prompt]
            )
            start = time.perf_counter()
            proc = subprocess.run(
                argv, cwd=project, env=env, capture_output=True, text=True, timeout=90
            )
            elapsed = time.perf_counter() - start
            (evidence / f"turn-{turn}-stdout.json").write_text(proc.stdout)
            (evidence / f"turn-{turn}-stderr.txt").write_text(proc.stderr)
            output = json.loads(proc.stdout)
            session = output.get("session_id", session)
            try:
                answer = json.loads(output.get("final_output", ""))
            except Exception:
                answer = None
            new = {k: v for k, v in model.outputs.items() if k not in before_outputs}
            row = {
                "turn": turn,
                "event": model.event,
                "pass": answer == expected,
                "answer": answer,
                "wall_seconds": elapsed,
                "exit_code": proc.returncode,
                "model_requests": len(model.main) - before_main,
                "tool_calls": len(model.calls) - before_calls,
                "new_tool_result_text_bytes": sum(
                    len(text_of(v.get("output")).encode()) for v in new.values()
                ),
                "main_request_json_bytes": sum(
                    len(
                        json.dumps(
                            v, ensure_ascii=False, separators=(",", ":")
                        ).encode()
                    )
                    for v in model.main[before_main:]
                ),
            }
            turns.append(row)
            print(json.dumps({"route": route, "rep": rep, **row}), flush=True)
        result = {
            "route": route,
            "rep": rep,
            "passes": sum(t["pass"] for t in turns),
            "turns": turns,
            "total_wall_seconds": sum(t["wall_seconds"] for t in turns),
            "total_tool_result_text_bytes": sum(
                t["new_tool_result_text_bytes"] for t in turns
            ),
            "total_main_request_json_bytes": sum(
                t["main_request_json_bytes"] for t in turns
            ),
            "total_tool_calls": len(model.calls),
            "total_model_requests": len(model.main),
            "review_requests": sum(v["kind"] == "permission" for v in model.side),
            "title_requests": sum(v["kind"] == "title" for v in model.side),
            "fixture_bytes": (project / "activity.log").stat().st_size,
        }
        dump(evidence / "metrics.json", result)
        dump(evidence / "requests.json", model.requests)
        dump(evidence / "calls.json", model.calls)
        dump(evidence / "tool-results.json", model.outputs)
        return result
    except Exception as error:
        dump(evidence / "error.json", {"error": repr(error), "turns": turns})
        dump(evidence / "requests.json", model.requests)
        dump(evidence / "calls.json", model.calls)
        dump(evidence / "tool-results.json", model.outputs)
        raise
    finally:
        model.close()
        shutil.rmtree(scratch)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--fx", required=True)
    p.add_argument("--node", required=True)
    p.add_argument("--cm-server", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--repetitions", type=int, default=3)
    args = p.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    all_results = []
    for rep in range(1, args.repetitions + 1):
        for route in (["native", "cm"] if rep % 2 else ["cm", "native"]):
            all_results.append(run(args, out, route, rep))
            dump(out / "all-metrics.json", all_results)
    summary = []
    for route in ("native", "cm"):
        rows = [r for r in all_results if r["route"] == route]
        item = {
            "route": route,
            "passes": sum(r["passes"] for r in rows),
            "turns": sum(len(r["turns"]) for r in rows),
        }
        for k in (
            "total_wall_seconds",
            "total_tool_result_text_bytes",
            "total_main_request_json_bytes",
            "total_tool_calls",
            "total_model_requests",
        ):
            v = [r[k] for r in rows]
            item[k] = dict(median=statistics.median(v), min=min(v), max=max(v))
        summary.append(item)
    dump(out / "summary.json", summary)


if __name__ == "__main__":
    main()
