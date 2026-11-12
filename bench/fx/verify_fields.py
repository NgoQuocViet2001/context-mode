#!/usr/bin/env python3
"""Classify literal answer fields in saved lookup replies, without filling missing data."""

import argparse
import json
import pathlib
import re

from bench import semantic_text

FIELDS = ("event", "endpoint", "status", "latency_ms", "release")


def nested_texts(value):
    if isinstance(value, str):
        yield value
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return
        if isinstance(parsed, (dict, list)):
            yield from nested_texts(parsed)
    elif isinstance(value, dict):
        for child in value.values():
            yield from nested_texts(child)
    elif isinstance(value, list):
        for child in value:
            yield from nested_texts(child)


def visible_records(reply, event):
    """Read complete literal values in one JSONL record; never consult the oracle."""
    candidates = []
    for text in nested_texts(reply):
        for line in text.splitlines():
            event_key = re.findall(r'(?<!\\)"event"\s*:\s*"([^"\\]*)"', line)
            if event_key != [event]:
                continue
            fields = {}
            for key in FIELDS:
                matches = list(re.finditer(r'(?<!\\)"' + key + r'"\s*:\s*', line))
                if len(matches) != 1:
                    break
                remainder = line[matches[0].end() :]
                try:
                    value, end = json.JSONDecoder().raw_decode(remainder)
                except ValueError:
                    break
                following = remainder[end:]
                if following and following[0] not in ",} \t\r":
                    break
                if isinstance(value, int) and not following.strip():
                    # A bare numeric EOF can hide more digits. Only a valid HTTP status
                    # has a fixed three-digit domain; other numeric EOFs stay unverified.
                    if key != "status" or not 100 <= value <= 599:
                        break
                fields[key] = value
            if set(fields) != set(FIELDS):
                continue
            if not all(
                isinstance(fields[k], str) for k in ("event", "endpoint", "release")
            ):
                continue
            if not all(type(fields[k]) is int for k in ("status", "latency_ms")):
                continue
            if not 100 <= fields["status"] <= 599:
                continue
            strict = False
            start = line.find("{")
            if start >= 0:
                try:
                    parsed, _ = json.JSONDecoder().raw_decode(line[start:])
                    strict = isinstance(parsed, dict) and all(
                        parsed.get(key) == fields[key] for key in FIELDS
                    )
                except ValueError:
                    pass
            candidates.append({"fields": fields, "strict_json": strict, "record": line})
    unique = {json.dumps(row["fields"], sort_keys=True) for row in candidates}
    if len(unique) != 1:
        return None
    return max(candidates, key=lambda row: row["strict_json"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("results", type=pathlib.Path)
    parser.add_argument("--out", type=pathlib.Path)
    args = parser.parse_args()
    checked = []
    for run in sorted(args.results.iterdir()):
        if not run.is_dir() or not (run / "oracle.json").exists():
            continue
        oracle = {
            row["event"]: row for row in json.loads((run / "oracle.json").read_text())
        }
        calls = json.loads((run / "calls.json").read_text())
        outputs = json.loads((run / "tool-results.json").read_text())
        for call in calls:
            if call["name"] == "grep_files":
                event = call["args"]["pattern"]
            elif call["name"].endswith("_ctx_search"):
                event = call["args"]["queries"][0]
            else:
                continue
            value = visible_records(semantic_text(outputs[call["id"]]["output"]), event)
            checked.append(
                {
                    "run": run.name,
                    "call_id": call["id"],
                    "event": event,
                    "visible_field_pass": value is not None
                    and value["fields"] == oracle[event],
                    "strict_record_json": value is not None and value["strict_json"],
                    "observed": value,
                }
            )
    result = {
        "method": "Posthoc literal fields from one returned record. No missing key or value is filled from oracle. Strict final-answer results remain unchanged.",
        "records": checked,
    }
    for route in ("native", "cm"):
        rows = [row for row in checked if row["run"].startswith(route + "-")]
        result[route] = {
            "queries": len(rows),
            "visible_field_passes": sum(row["visible_field_pass"] for row in rows),
            "strict_record_json": sum(row["strict_record_json"] for row in rows),
        }
    output = args.out or args.results / "visible-fields.json"
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({route: result[route] for route in ("native", "cm")}, indent=2))


if __name__ == "__main__":
    main()
