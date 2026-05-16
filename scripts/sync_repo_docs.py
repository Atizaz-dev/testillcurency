#!/usr/bin/env python3
"""Synchronize repository context docs for fast human/agent onboarding.

This script is deterministic for a given commit and config state.
It updates:
- docs/REPO_CONTEXT.md (auto snapshot block)
- docs/AI_HANDOFF.md (generated handoff block)
"""
from __future__ import annotations

import subprocess
import sys
import os
from pathlib import Path
from typing import Any

try:
    import yaml
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "PyYAML is required. Install with: python -m pip install pyyaml"
    ) from exc


AUTO_DOC_START = "<!-- verity:auto-doc:start -->"
AUTO_DOC_END = "<!-- verity:auto-doc:end -->"
AUTO_HANDOFF_START = "<!-- verity:auto-handoff:start -->"
AUTO_HANDOFF_END = "<!-- verity:auto-handoff:end -->"


def run_git(*args: str) -> str:
    try:
        completed = subprocess.run(
            ["git", *args],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        return ""
    return completed.stdout.strip()


def bool_value(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


def as_command_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value).strip()
    return [text] if text else []


def markdown_list(values: list[str], fallback: str = "_(none configured)_") -> str:
    if not values:
        return fallback
    return "\n".join(f"- `{item}`" for item in values)


def detect_repository() -> str:
    # Prefer environment when available in GitHub Actions.
    from_env = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if from_env:
        return from_env

    remote = run_git("remote", "get-url", "origin")
    if not remote:
        return "unknown/unknown"
    normalized = remote.replace("git@github.com:", "https://github.com/")
    normalized = normalized.rstrip("/")
    if normalized.endswith(".git"):
        normalized = normalized[:-4]
    if "github.com/" in normalized:
        return normalized.split("github.com/", 1)[1]
    return normalized


def detect_default_branch() -> str:
    from_env = os.environ.get("GITHUB_BASE_REF", "").strip()
    if from_env:
        return from_env
    symbolic = run_git("symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if symbolic.startswith("origin/"):
        return symbolic.split("/", 1)[1]
    return "main"


def top_level_directories() -> list[str]:
    ignore = {
        ".git",
        ".github",
        ".verity",
        ".venv",
        ".claude",
        "__pycache__",
        "node_modules",
        "dist",
        "build",
    }
    dirs = []
    for entry in sorted(Path(".").iterdir(), key=lambda p: p.name.lower()):
        if entry.is_dir() and entry.name not in ignore:
            dirs.append(entry.name)
    return dirs


def key_paths() -> list[str]:
    candidates = [
        "AGENTS.md",
        "README.md",
        ".verity/config.yml",
        "docs/REPO_CONTEXT.md",
        "docs/AI_HANDOFF.md",
        "docs/use-cases.md",
        "backend/handlers",
        "backend/services",
        "frontend/src",
        "scripts",
        ".github/workflows",
    ]
    return [path for path in candidates if Path(path).exists()]


def workflow_files() -> list[str]:
    workflow_dir = Path(".github/workflows")
    if not workflow_dir.exists():
        return []
    return sorted(
        [
            item.name
            for item in workflow_dir.iterdir()
            if item.is_file() and item.suffix in {".yml", ".yaml"}
        ]
    )


def apply_marker_block(content: str, start: str, end: str, body: str) -> str:
    block = f"{start}\n{body}\n{end}"
    start_index = content.find(start)
    end_index = content.find(end)
    if start_index != -1 and end_index != -1 and end_index > start_index:
        end_index += len(end)
        return f"{content[:start_index]}{block}{content[end_index:]}"
    if content and not content.endswith("\n"):
        content += "\n"
    return f"{content}\n{block}\n"


def write_if_changed(path: Path, content: str) -> bool:
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if existing == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


def load_config(config_path: Path) -> dict[str, Any]:
    if not config_path.exists():
        return {}
    parsed = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    return parsed if isinstance(parsed, dict) else {}


def render_context_snapshot(
    commit_sha: str,
    commit_date: str,
    repository: str,
    default_branch: str,
    commands: dict[str, Any],
    policies: dict[str, Any],
) -> str:
    setup = as_command_list(commands.get("setup"))
    test = as_command_list(commands.get("test"))
    build = as_command_list(commands.get("build"))
    deploy = as_command_list(commands.get("deploy"))

    policy_flags = []
    for name in sorted(policies.keys()):
        value = policies.get(name)
        if isinstance(value, dict) and "enabled" in value:
            policy_flags.append(f"- `{name}.enabled`: `{bool_value(value.get('enabled'))}`")

    lines = [
        f"- Commit: `{commit_sha or 'unknown'}`",
        f"- Commit date: `{commit_date or 'unknown'}`",
        f"- Repository: `{repository}`",
        f"- Default branch: `{default_branch}`",
        "",
        "### Configured Commands",
        f"Setup:\n{markdown_list(setup)}",
        f"Tests:\n{markdown_list(test)}",
        f"Build:\n{markdown_list(build)}",
        f"Deploy:\n{markdown_list(deploy)}",
        "",
        "### Top-level Directories",
        markdown_list(top_level_directories(), "_(none detected)_"),
        "",
        "### Workflow Files",
        markdown_list(workflow_files(), "_(none detected)_"),
        "",
        "### Enabled Policy Flags",
        markdown_list(policy_flags, "_(none detected)_"),
    ]
    return "\n".join(lines)


def render_handoff_block(
    commit_sha: str,
    commit_date: str,
    repository: str,
    default_branch: str,
    commands: dict[str, Any],
) -> str:
    setup = as_command_list(commands.get("setup"))
    test = as_command_list(commands.get("test"))
    build = as_command_list(commands.get("build"))
    deploy = as_command_list(commands.get("deploy"))

    lines = [
        "## Snapshot",
        f"- Repository: `{repository}`",
        f"- Default branch: `{default_branch}`",
        f"- Commit: `{commit_sha or 'unknown'}`",
        f"- Commit date: `{commit_date or 'unknown'}`",
        "",
        "## Start Here",
        "1. Read `AGENTS.md`.",
        "2. Read `.verity/config.yml`.",
        "3. Read `docs/REPO_CONTEXT.md`.",
        "4. Read `docs/use-cases.md`.",
        "",
        "## Run Commands",
        f"Setup:\n{markdown_list(setup)}",
        f"Tests:\n{markdown_list(test)}",
        f"Build:\n{markdown_list(build)}",
        f"Deploy:\n{markdown_list(deploy)}",
        "",
        "## Key Paths",
        markdown_list(key_paths(), "_(none detected)_"),
        "",
        "## Workflow Index",
        markdown_list(workflow_files(), "_(none detected)_"),
    ]
    return "\n".join(lines)


def main() -> int:
    config_path = Path(".verity/config.yml")
    config = load_config(config_path)
    policies = config.get("policies", {}) if isinstance(config.get("policies"), dict) else {}
    docs_policy = policies.get("documentation", {}) if isinstance(policies.get("documentation"), dict) else {}
    auto_mode = bool_value(docs_policy.get("auto_mode"), True)
    if not auto_mode:
        print("Documentation auto mode disabled; skipping.")
        return 0

    repository = detect_repository()
    default_branch = detect_default_branch()
    commit_sha = run_git("rev-parse", "HEAD")
    commit_date = run_git("log", "-1", "--format=%cI")
    commands = config.get("commands", {}) if isinstance(config.get("commands"), dict) else {}

    repo_context_path = Path("docs/REPO_CONTEXT.md")
    handoff_file = str(docs_policy.get("handoff_file", "docs/AI_HANDOFF.md")).strip() or "docs/AI_HANDOFF.md"
    handoff_path = Path(handoff_file)

    context_content = repo_context_path.read_text(encoding="utf-8") if repo_context_path.exists() else "# Repo Context\n"
    context_replacements = {
        "__DETECTED_AT__": commit_date or "unknown",
        "__REPO__": repository,
        "main": default_branch,
        "__SUGGESTED_SETUP__": markdown_list(as_command_list(commands.get("setup"))),
        "__SUGGESTED_TEST__": markdown_list(as_command_list(commands.get("test"))),
        "__SUGGESTED_BUILD__": markdown_list(as_command_list(commands.get("build"))),
        "__SUGGESTED_DEPLOY__": markdown_list(as_command_list(commands.get("deploy"))),
    }
    for token, value in context_replacements.items():
        context_content = context_content.replace(token, value)

    context_snapshot = render_context_snapshot(
        commit_sha=commit_sha,
        commit_date=commit_date,
        repository=repository,
        default_branch=default_branch,
        commands=commands,
        policies=policies,
    )
    context_content = apply_marker_block(
        context_content,
        AUTO_DOC_START,
        AUTO_DOC_END,
        context_snapshot,
    )

    handoff_content = handoff_path.read_text(encoding="utf-8") if handoff_path.exists() else "# AI Handoff\n"
    handoff_snapshot = render_handoff_block(
        commit_sha=commit_sha,
        commit_date=commit_date,
        repository=repository,
        default_branch=default_branch,
        commands=commands,
    )
    handoff_content = apply_marker_block(
        handoff_content,
        AUTO_HANDOFF_START,
        AUTO_HANDOFF_END,
        handoff_snapshot,
    )

    changed = []
    if write_if_changed(repo_context_path, context_content):
        changed.append(str(repo_context_path))
    if write_if_changed(handoff_path, handoff_content):
        changed.append(str(handoff_path))

    if changed:
        print("Updated docs:")
        for item in changed:
            print(f"- {item}")
    else:
        print("Docs already up to date.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
