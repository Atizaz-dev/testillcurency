#!/usr/bin/env python3
"""Run the resolved Verity test suite with deterministic logging and summary output."""
from __future__ import annotations

from pathlib import Path
from urllib import request
import argparse
import json
import os
import signal
import subprocess
import sys
import time


ENVIRONMENT_PATTERNS = (
    "missing required secret",
    "missing required env",
    "no runnable test commands detected",
    "playwright prerequisites missing",
    "unable to reach e2e target",
    "permission denied (publickey)",
    "could not resolve host",
    "network is unreachable",
)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_line(handle, text: str) -> None:
    handle.write(text)
    handle.flush()
    sys.stdout.write(text)
    sys.stdout.flush()


def run_command(command: str, log_handle) -> tuple[int, str]:
    write_line(log_handle, f"=== RUN: {command}\n")
    proc = subprocess.Popen(
        command,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        executable="/bin/bash",
    )
    collected: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        collected.append(line)
        write_line(log_handle, line)
    proc.wait()
    write_line(log_handle, f"=== EXIT: {proc.returncode}\n\n")
    return proc.returncode, "".join(collected)


def wait_for_http(url: str, timeout_seconds: int, log_handle) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with request.urlopen(url, timeout=3) as response:
                if response.status < 500:
                    write_line(log_handle, f"[e2e] Target ready: {url}\n")
                    return True
        except Exception:
            time.sleep(2)
    write_line(log_handle, f"[e2e] Timed out waiting for {url}\n")
    return False


def terminate_process(proc: subprocess.Popen | None) -> None:
    if not proc:
        return
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def classify_failure(text: str) -> dict:
    lower = text.lower()
    for pattern in ENVIRONMENT_PATTERNS:
        if pattern in lower:
            return {"fixable": False, "category": "environment", "reason": pattern}
    return {"fixable": True, "category": "code", "reason": "test_failure"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resolved", default=".verity/resolved_commands.json")
    parser.add_argument("--log", default=".verity/test-output.txt")
    parser.add_argument("--summary", default=".verity/suite-result.json")
    parser.add_argument("--include-build", action="store_true")
    args = parser.parse_args()

    resolved = load_json(Path(args.resolved))
    log_path = Path(args.log)
    summary_path = Path(args.summary)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.parent.mkdir(parents=True, exist_ok=True)

    summary = {
        "success": False,
        "phase": "init",
        "failed_command": "",
        "fixable": False,
        "failure_category": "",
        "failure_reason": "",
        "stop_reason": "",
        "e2e": resolved.get("e2e", {}),
        "commands": resolved.get("test_groups", {}),
        "groups_run": {"unit": [], "integration": [], "e2e": [], "build": []},
        "groups_skipped": {},
    }

    with log_path.open("w", encoding="utf-8") as log_handle:
        unit_cmds = resolved.get("test_groups", {}).get("unit", []) or []
        integration_cmds = resolved.get("test_groups", {}).get("integration", []) or []
        e2e_cmds = resolved.get("test_groups", {}).get("e2e", []) or []

        if not unit_cmds and not integration_cmds and not e2e_cmds:
            message = "No runnable test commands detected.\n"
            write_line(log_handle, message)
            summary.update(
                {
                    "phase": "detect",
                    "failure_reason": "no_tests_detected",
                    "failure_category": "environment",
                    "fixable": False,
                    "stop_reason": "no_tests_detected",
                }
            )
            summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
            return 1

        server_proc: subprocess.Popen | None = None
        try:
            for phase_name, commands in (("unit", unit_cmds), ("integration", integration_cmds)):
                if not commands:
                    summary["groups_skipped"][phase_name] = "not_configured"
                    continue
                for command in commands:
                    summary["phase"] = phase_name
                    summary["groups_run"][phase_name].append(command)
                    exit_code, output = run_command(command, log_handle)
                    if exit_code != 0:
                        classification = classify_failure(output)
                        summary.update(
                            {
                                "failed_command": command,
                                "fixable": classification["fixable"],
                                "failure_category": classification["category"],
                                "failure_reason": classification["reason"],
                                "stop_reason": classification["reason"],
                            }
                        )
                        summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
                        return exit_code

            e2e_cfg = resolved.get("e2e", {}) or {}
            if e2e_cfg.get("detected") and not e2e_cfg.get("runnable"):
                reason = str(e2e_cfg.get("reason") or "not_runnable")
                write_line(log_handle, f"[e2e] Skipped: {reason}\n")
                summary["groups_skipped"]["e2e"] = reason
            elif not e2e_cfg.get("detected"):
                summary["groups_skipped"]["e2e"] = "not_detected"

            if e2e_cfg.get("detected") and e2e_cfg.get("runnable"):
                start_command = str(e2e_cfg.get("start_command") or "").strip()
                base_url = str(e2e_cfg.get("base_url") or "").strip()
                if start_command:
                    write_line(log_handle, f"[e2e] Starting target: {start_command}\n")
                    server_proc = subprocess.Popen(
                        start_command,
                        shell=True,
                        stdout=log_handle,
                        stderr=subprocess.STDOUT,
                        executable="/bin/bash",
                        preexec_fn=os.setsid,
                    )
                if base_url and not wait_for_http(base_url, 90, log_handle):
                    summary.update(
                        {
                            "phase": "e2e",
                            "failed_command": start_command,
                            "fixable": False,
                            "failure_category": "environment",
                            "failure_reason": "unable to reach e2e target",
                            "stop_reason": "unable_to_reach_e2e_target",
                        }
                    )
                    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
                    return 1

                for command in e2e_cmds:
                    summary["phase"] = "e2e"
                    summary["groups_run"]["e2e"].append(command)
                    env = os.environ.copy()
                    if base_url:
                        env.setdefault(str(e2e_cfg.get("base_url_env") or "PLAYWRIGHT_BASE_URL"), base_url)
                    write_line(log_handle, f"=== RUN: {command}\n")
                    proc = subprocess.Popen(
                        command,
                        shell=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        executable="/bin/bash",
                        env=env,
                    )
                    assert proc.stdout is not None
                    captured: list[str] = []
                    for line in proc.stdout:
                        captured.append(line)
                        write_line(log_handle, line)
                    proc.wait()
                    write_line(log_handle, f"=== EXIT: {proc.returncode}\n\n")
                    if proc.returncode != 0:
                        classification = classify_failure("".join(captured))
                        summary.update(
                            {
                                "failed_command": command,
                                "fixable": classification["fixable"],
                                "failure_category": classification["category"],
                                "failure_reason": classification["reason"],
                                "stop_reason": classification["reason"],
                            }
                        )
                        summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
                        return proc.returncode

            if args.include_build:
                for command in resolved.get("build", []) or []:
                    summary["phase"] = "build"
                    summary["groups_run"]["build"].append(command)
                    exit_code, output = run_command(command, log_handle)
                    if exit_code != 0:
                        classification = classify_failure(output)
                        summary.update(
                            {
                                "failed_command": command,
                                "fixable": classification["fixable"],
                                "failure_category": classification["category"],
                                "failure_reason": classification["reason"],
                                "stop_reason": classification["reason"],
                            }
                        )
                        summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
                        return exit_code
            else:
                summary["groups_skipped"]["build"] = "not_requested"

            summary.update(
                {
                    "success": True,
                    "phase": "completed",
                    "fixable": False,
                    "failure_category": "",
                    "failure_reason": "",
                    "stop_reason": "success",
                }
            )
            summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
            return 0
        finally:
            if server_proc and server_proc.poll() is None:
                try:
                    os.killpg(os.getpgid(server_proc.pid), signal.SIGTERM)
                except Exception:
                    terminate_process(server_proc)


if __name__ == "__main__":
    raise SystemExit(main())
