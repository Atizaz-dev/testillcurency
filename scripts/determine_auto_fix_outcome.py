#!/usr/bin/env python3
"""Derive smart PR auto-fix stop conditions from suite summaries and git results."""
from __future__ import annotations

from pathlib import Path
import hashlib
import json
import os
import sys


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def fingerprint(summary: dict) -> str:
    payload = {
        "phase": summary.get("phase"),
        "failure_reason": summary.get("failure_reason"),
        "failure_category": summary.get("failure_category"),
        "failed_command": summary.get("failed_command"),
        "groups_run": summary.get("groups_run"),
        "groups_skipped": summary.get("groups_skipped"),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def read_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "")
    if not raw:
        return default
    return raw.strip().lower() == "true"


def main() -> int:
    if len(sys.argv) not in {2, 3}:
        raise SystemExit("usage: determine_auto_fix_outcome.py <summary.json> [previous_summary.json]")
    summary = load_json(Path(sys.argv[1]))
    previous = load_json(Path(sys.argv[2])) if len(sys.argv) > 2 and Path(sys.argv[2]).exists() else None

    success = bool(summary.get("success"))
    fixable = bool(summary.get("fixable"))
    category = str(summary.get("failure_category") or "")
    stop_reason = str(summary.get("stop_reason") or "")
    current_fingerprint = fingerprint(summary)
    previous_fingerprint = fingerprint(previous) if previous else ""
    code_changed = read_bool("VERITY_CODE_CHANGED", True)

    should_continue = False
    if success:
        stop_reason = "success"
    elif not fixable or category == "environment":
        stop_reason = stop_reason or "non_fixable_failure"
    elif not code_changed:
        stop_reason = "no_code_change"
    elif previous and current_fingerprint == previous_fingerprint:
        stop_reason = "unchanged_failure_fingerprint"
    else:
        stop_reason = stop_reason or "needs_retry"
        should_continue = True

    out = os.environ["GITHUB_OUTPUT"]
    with open(out, "a", encoding="utf-8") as handle:
        handle.write(f"fingerprint={current_fingerprint}\n")
        handle.write(f"stop_reason={stop_reason}\n")
        handle.write(f"should_continue={'true' if should_continue else 'false'}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
