#!/usr/bin/env python3
"""Export normalized workflow outputs from a Verity suite summary JSON file."""
from __future__ import annotations

from pathlib import Path
import json
import os
import sys


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: evaluate_suite_result.py <summary.json>")
    summary_path = Path(sys.argv[1])
    data = json.loads(summary_path.read_text(encoding="utf-8"))
    output_path = os.environ["GITHUB_OUTPUT"]

    success = bool(data.get("success"))
    fixable = bool(data.get("fixable"))
    needs_fix = (not success) and fixable
    reason = str(data.get("failure_reason") or "")
    category = str(data.get("failure_category") or "")
    phase = str(data.get("phase") or "")
    stop_reason = str(data.get("stop_reason") or "")
    e2e_reason = str((data.get("groups_skipped") or {}).get("e2e") or "")
    groups_run = json.dumps(data.get("groups_run") or {}, separators=(",", ":"))
    groups_skipped = json.dumps(data.get("groups_skipped") or {}, separators=(",", ":"))

    with open(output_path, "a", encoding="utf-8") as handle:
        handle.write(f"success={'true' if success else 'false'}\n")
        handle.write(f"fixable={'true' if fixable else 'false'}\n")
        handle.write(f"needs_fix={'true' if needs_fix else 'false'}\n")
        handle.write(f"failure_reason={reason}\n")
        handle.write(f"failure_category={category}\n")
        handle.write(f"phase={phase}\n")
        handle.write(f"stop_reason={stop_reason}\n")
        handle.write(f"e2e_skip_reason={e2e_reason}\n")
        handle.write(f"groups_run={groups_run}\n")
        handle.write(f"groups_skipped={groups_skipped}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
