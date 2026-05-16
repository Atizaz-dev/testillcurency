#!/usr/bin/env python3
"""Detect and normalize Verity repo commands for CI automation.

This script can operate in two modes:
- default: emit conservative repo-detected commands
- --merge-config: merge `.verity/config.yml` overrides with detected commands

The output is deterministic JSON so workflows can consume a stable command plan.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import argparse
import json
import os
import time

try:
    import yaml
except Exception:
    yaml = None


@dataclass
class Suggestions:
    setup: list[str]
    test: list[str]
    build: list[str]
    deploy: list[str]
    test_groups: dict[str, list[str]]
    e2e: dict[str, object]
    notes: list[str]


def exists(path: str) -> bool:
    return Path(path).exists()


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    if yaml is None:
        raise RuntimeError("PyYAML is required to read .verity/config.yml")
    try:
        parsed = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def norm_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value).strip()
    return [text] if text else []


def dedupe(items: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        normalized = str(item).strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        out.append(normalized)
    return out


def first_non_empty(*values: object) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def merge_required_env(current: list[str], candidate: list[str]) -> list[str]:
    return dedupe(list(current or []) + list(candidate or []))


def choose_e2e_meta(current: dict[str, object], candidate: dict[str, object]) -> dict[str, object]:
    if not candidate.get("detected"):
        return current
    if not current.get("detected"):
        return candidate

    def score(meta: dict[str, object]) -> tuple[int, int, int]:
        runnable = 1 if meta.get("runnable") else 0
        path = str(meta.get("project_path") or "")
        frontend_hint = 1 if path in {"frontend", "web", "client", "app"} or path.startswith("apps/") else 0
        has_target = 1 if str(meta.get("base_url") or "").strip() or str(meta.get("start_command") or "").strip() else 0
        return (runnable, frontend_hint, has_target)

    chosen = candidate if score(candidate) > score(current) else current
    other = current if chosen is candidate else candidate
    chosen["command"] = dedupe(list(chosen.get("command", []) or []) + list(other.get("command", []) or []))
    chosen["required_env"] = merge_required_env(
        list(chosen.get("required_env", []) or []),
        list(other.get("required_env", []) or []),
    )
    return chosen


def resolve_e2e_state(
    *,
    detected: bool,
    commands: list[str],
    start_command: str,
    base_url: str,
    base_url_env: str,
    required_env: list[str],
    enabled_mode: str,
    project_path: str,
) -> dict[str, object]:
    missing_env = [name for name in dedupe(required_env) if not os.environ.get(name, "").strip()]
    runnable = False
    reason = "not_detected"
    if detected:
        if enabled_mode == "false":
            reason = "disabled"
        elif not (base_url or start_command):
            reason = "missing_target"
        elif missing_env:
            reason = "missing_env"
        else:
            runnable = True
            reason = "ready"
    return {
        "detected": bool(detected),
        "runnable": runnable,
        "command": dedupe(commands),
        "start_command": start_command,
        "base_url": base_url,
        "base_url_env": base_url_env or "PLAYWRIGHT_BASE_URL",
        "required_env": dedupe(required_env),
        "missing_env": missing_env,
        "reason": reason,
        "project_path": project_path,
    }


def has_any(paths: list[Path]) -> bool:
    return any(path.exists() for path in paths)


def detect_package_manager(project_dir: Path, pkg: dict) -> tuple[str, str]:
    package_manager = str(pkg.get("packageManager") or "").lower()
    if (project_dir / "pnpm-lock.yaml").exists() or package_manager.startswith("pnpm@"):
        return ("pnpm", "pnpm install --frozen-lockfile")
    if (project_dir / "yarn.lock").exists() or package_manager.startswith("yarn@"):
        return ("yarn", "yarn install --frozen-lockfile")
    if (project_dir / "package-lock.json").exists() or package_manager.startswith("npm@"):
        return ("npm", "npm ci")
    return ("npm", "npm install")


def wrap_cmd(project_dir: Path, command: str) -> str:
    if project_dir == Path("."):
        return command
    return f"cd {project_dir.as_posix()} && {command}"


def detect_node_projects() -> list[tuple[Path, dict]]:
    candidates: list[Path] = []
    for candidate in [Path("."), Path("frontend"), Path("backend"), Path("web"), Path("client"), Path("app")]:
        pkg = candidate / "package.json" if candidate != Path(".") else Path("package.json")
        if pkg.exists():
            candidates.append(candidate)

    apps_dir = Path("apps")
    if apps_dir.exists():
        for child in sorted(apps_dir.iterdir()):
            if child.is_dir() and (child / "package.json").exists():
                candidates.append(child)

    seen: set[str] = set()
    projects: list[tuple[Path, dict]] = []
    for project_dir in candidates:
        key = project_dir.as_posix()
        if key in seen:
            continue
        seen.add(key)
        pkg_path = project_dir / "package.json" if project_dir != Path(".") else Path("package.json")
        projects.append((project_dir, load_json(pkg_path)))
    return projects


def detect_node_commands() -> Suggestions:
    setup: list[str] = []
    build: list[str] = []
    deploy: list[str] = []
    unit: list[str] = []
    integration: list[str] = []
    e2e: list[str] = []
    notes: list[str] = []
    e2e_meta = {
        "detected": False,
        "runnable": False,
        "command": [],
        "start_command": "",
        "base_url": os.environ.get("PLAYWRIGHT_BASE_URL", "").strip(),
        "base_url_env": "PLAYWRIGHT_BASE_URL",
        "required_env": [],
        "reason": "not_detected",
        "project_path": "",
    }

    for project_dir, pkg in detect_node_projects():
        scripts = pkg.get("scripts", {}) if isinstance(pkg.get("scripts"), dict) else {}
        deps = {
            **(pkg.get("dependencies", {}) if isinstance(pkg.get("dependencies"), dict) else {}),
            **(pkg.get("devDependencies", {}) if isinstance(pkg.get("devDependencies"), dict) else {}),
        }

        if not scripts and not deps:
            continue

        manager, install_cmd = detect_package_manager(project_dir, pkg)
        setup.append(wrap_cmd(project_dir, install_cmd))

        if "build" in scripts:
            build.append(wrap_cmd(project_dir, f"{manager} run build"))

        if "test" in scripts:
            unit.append(wrap_cmd(project_dir, f"{manager} test"))
        elif "test:unit" in scripts:
            unit.append(wrap_cmd(project_dir, f"{manager} run test:unit"))

        if "test:integration" in scripts:
            integration.append(wrap_cmd(project_dir, f"{manager} run test:integration"))
        elif "integration" in scripts:
            integration.append(wrap_cmd(project_dir, f"{manager} run integration"))

        frontend_stack = ""
        if "next" in deps:
            frontend_stack = "next"
            notes.append(f"Detected Next.js project at {project_dir.as_posix()}.")
        elif "react" in deps:
            frontend_stack = "react"
            notes.append(f"Detected React project at {project_dir.as_posix()}.")
        else:
            notes.append(f"Detected Node project at {project_dir.as_posix()}.")

        playwright_detected = (
            "@playwright/test" in deps
            or "playwright" in deps
            or (project_dir / "playwright.config.ts").exists()
            or (project_dir / "playwright.config.js").exists()
            or (project_dir / "e2e").exists()
        )
        if playwright_detected:
            candidate_meta = {
                "detected": True,
                "runnable": False,
                "command": [],
                "start_command": "",
                "base_url": os.environ.get("PLAYWRIGHT_BASE_URL", "").strip(),
                "base_url_env": "PLAYWRIGHT_BASE_URL",
                "required_env": [],
                "reason": "not_detected",
                "project_path": project_dir.as_posix(),
            }
            e2e_command = ""
            if "test:e2e" in scripts:
                e2e_command = wrap_cmd(project_dir, f"{manager} run test:e2e")
            elif "e2e" in scripts:
                e2e_command = wrap_cmd(project_dir, f"{manager} run e2e")
            else:
                e2e_command = wrap_cmd(project_dir, f"{manager} exec playwright test")
            e2e.append(e2e_command)
            candidate_meta["command"] = [e2e_command]

            start_command = ""
            if "start:e2e" in scripts:
                start_command = wrap_cmd(project_dir, f"{manager} run start:e2e")
            elif "dev" in scripts:
                suffix = " -- --hostname 0.0.0.0"
                if manager == "npm":
                    suffix = " -- --host 0.0.0.0"
                start_command = wrap_cmd(project_dir, f"{manager} run dev{suffix}")
            elif "start" in scripts:
                start_command = wrap_cmd(project_dir, f"{manager} run start")
            elif "preview" in scripts:
                suffix = " -- --host 0.0.0.0" if manager == "npm" else " -- --host 0.0.0.0"
                start_command = wrap_cmd(project_dir, f"{manager} run preview{suffix}")
            candidate_meta["start_command"] = start_command

            if not candidate_meta["base_url"]:
                if frontend_stack == "next":
                    candidate_meta["base_url"] = "http://127.0.0.1:3000"
                elif "preview" in scripts:
                    candidate_meta["base_url"] = "http://127.0.0.1:4173"
                elif "dev" in scripts:
                    candidate_meta["base_url"] = "http://127.0.0.1:5173"

            required_env: list[str] = []
            for env_name in ["VERITY_E2E_EMAIL", "VERITY_E2E_PASSWORD"]:
                if not os.environ.get(env_name, "").strip():
                    required_env.append(env_name)
            candidate_meta = resolve_e2e_state(
                detected=True,
                commands=[e2e_command],
                start_command=start_command,
                base_url=str(candidate_meta.get("base_url") or "").strip(),
                base_url_env=str(candidate_meta.get("base_url_env") or "PLAYWRIGHT_BASE_URL").strip(),
                required_env=required_env,
                enabled_mode="auto",
                project_path=project_dir.as_posix(),
            )
            e2e_meta = choose_e2e_meta(e2e_meta, candidate_meta)

    test = dedupe(unit + integration + (e2e if e2e_meta["runnable"] else []))
    return Suggestions(
        setup=dedupe(setup),
        test=test,
        build=dedupe(build),
        deploy=dedupe(deploy),
        test_groups={
            "unit": dedupe(unit),
            "integration": dedupe(integration),
            "e2e": dedupe(e2e),
        },
        e2e=e2e_meta,
        notes=dedupe(notes),
    )


def detect_python_commands() -> Suggestions:
    setup: list[str] = []
    build: list[str] = []
    deploy: list[str] = []
    unit: list[str] = []
    integration: list[str] = []
    notes: list[str] = []
    e2e_meta = {
        "detected": False,
        "runnable": False,
        "command": [],
        "start_command": "",
        "base_url": "",
        "base_url_env": "PLAYWRIGHT_BASE_URL",
        "required_env": [],
        "reason": "not_detected",
        "project_path": "",
    }

    candidates = [Path("."), Path("backend")]
    for project_dir in candidates:
        req = project_dir / "requirements.txt" if project_dir != Path(".") else Path("requirements.txt")
        pyproject = project_dir / "pyproject.toml" if project_dir != Path(".") else Path("pyproject.toml")
        setup_py = project_dir / "setup.py" if project_dir != Path(".") else Path("setup.py")
        if not has_any([req, pyproject, setup_py]):
            continue

        if req.exists():
            setup.append(wrap_cmd(project_dir, "python -m pip install -r requirements.txt"))
        elif pyproject.exists():
            setup.append(wrap_cmd(project_dir, "python -m pip install -e ."))
        elif setup_py.exists():
            setup.append(wrap_cmd(project_dir, "python -m pip install -e ."))

        tests_dir = project_dir / "tests"
        integration_dir = tests_dir / "integration"
        if tests_dir.exists() or (project_dir / "pytest.ini").exists() or pyproject.exists():
            unit.append(wrap_cmd(project_dir, "pytest"))
        if integration_dir.exists():
            integration.append(wrap_cmd(project_dir, "pytest tests/integration"))

        if (project_dir / "manage.py").exists():
            build.append(wrap_cmd(project_dir, "python manage.py check"))

        notes.append(f"Detected Python project at {project_dir.as_posix()}.")

    return Suggestions(
        setup=dedupe(setup),
        test=dedupe(unit + integration),
        build=dedupe(build),
        deploy=dedupe(deploy),
        test_groups={
            "unit": dedupe(unit),
            "integration": dedupe(integration),
            "e2e": [],
        },
        e2e=e2e_meta,
        notes=dedupe(notes),
    )


def combine_suggestions(parts: list[Suggestions]) -> Suggestions:
    setup: list[str] = []
    test: list[str] = []
    build: list[str] = []
    deploy: list[str] = []
    notes: list[str] = []
    groups = {"unit": [], "integration": [], "e2e": []}
    e2e_meta = {
        "detected": False,
        "runnable": False,
        "command": [],
        "start_command": "",
        "base_url": "",
        "base_url_env": "PLAYWRIGHT_BASE_URL",
        "required_env": [],
        "reason": "not_detected",
        "project_path": "",
    }

    for part in parts:
        setup.extend(part.setup)
        test.extend(part.test)
        build.extend(part.build)
        deploy.extend(part.deploy)
        notes.extend(part.notes)
        for name in groups:
            groups[name].extend(part.test_groups.get(name, []))
        e2e_meta = choose_e2e_meta(e2e_meta, part.e2e)

    return Suggestions(
        setup=dedupe(setup),
        test=dedupe(test),
        build=dedupe(build),
        deploy=dedupe(deploy),
        test_groups={name: dedupe(values) for name, values in groups.items()},
        e2e=e2e_meta,
        notes=dedupe(notes),
    )


def detect() -> Suggestions:
    suggestions = combine_suggestions([detect_node_commands(), detect_python_commands()])
    if not suggestions.test:
        suggestions.notes.append("No runnable test commands detected. Configure .verity/config.yml manually.")
    return suggestions


def merge_with_config(detected: Suggestions, config: dict) -> dict:
    commands = config.get("commands", {}) if isinstance(config.get("commands"), dict) else {}
    automation = config.get("automation", {}) if isinstance(config.get("automation"), dict) else {}
    configured_groups = commands.get("test_groups", {}) if isinstance(commands.get("test_groups"), dict) else {}
    e2e_cfg = automation.get("e2e", {}) if isinstance(automation.get("e2e"), dict) else {}
    auto_fix_cfg = automation.get("test_auto_fix", {}) if isinstance(automation.get("test_auto_fix"), dict) else {}

    setup = norm_list(commands.get("setup")) or detected.setup
    build = norm_list(commands.get("build")) or detected.build
    deploy = norm_list(commands.get("deploy")) or detected.deploy

    explicit_test = norm_list(commands.get("test"))
    unit = norm_list(configured_groups.get("unit")) or detected.test_groups.get("unit", [])
    integration = norm_list(configured_groups.get("integration")) or detected.test_groups.get("integration", [])
    configured_e2e = norm_list(configured_groups.get("e2e")) or norm_list(e2e_cfg.get("command"))
    e2e = configured_e2e or detected.test_groups.get("e2e", [])

    base_url_env = first_non_empty(e2e_cfg.get("base_url_env"), detected.e2e.get("base_url_env"), "PLAYWRIGHT_BASE_URL")
    base_url = first_non_empty(
        e2e_cfg.get("base_url"),
        os.environ.get(base_url_env, ""),
        detected.e2e.get("base_url"),
    )
    required_env = norm_list(e2e_cfg.get("required_env")) or list(detected.e2e.get("required_env", []))
    start_command = first_non_empty(e2e_cfg.get("start_command"), detected.e2e.get("start_command"))
    enabled_mode = str(e2e_cfg.get("enabled") or "auto").strip().lower()

    e2e_state = resolve_e2e_state(
        detected=bool(e2e),
        commands=e2e,
        start_command=start_command,
        base_url=base_url,
        base_url_env=base_url_env,
        required_env=required_env,
        enabled_mode=enabled_mode,
        project_path=str(detected.e2e.get("project_path") or ""),
    )

    risk_level = "full" if len(detected.notes) > 1 or len(unit) + len(integration) + len(e2e) > 2 else "standard"
    runnable_e2e = dedupe(e2e_state["command"]) if e2e_state["runnable"] else []
    flat_test = explicit_test or dedupe(unit + integration + runnable_e2e)

    resolved = {
        "detected_at": int(time.time()),
        "setup": dedupe(setup),
        "test": dedupe(flat_test),
        "build": dedupe(build),
        "deploy": dedupe(deploy),
        "test_groups": {
            "unit": dedupe(unit),
            "integration": dedupe(integration),
            "e2e": dedupe(e2e),
        },
        "risk": {
            "level": risk_level,
            "requires_full_suite": bool(explicit_test),
        },
        "e2e": e2e_state,
        "auto_fix": {
            "enabled": bool(auto_fix_cfg.get("enabled", True)),
            "max_attempts": int(auto_fix_cfg.get("max_attempts", 3) or 3),
            "post_merge_validation": bool(auto_fix_cfg.get("post_merge_validation", True)),
            "pr_triggers": norm_list(auto_fix_cfg.get("pr_triggers")) or ["opened", "synchronize", "reopened"],
        },
        "notes": dedupe(detected.notes),
    }
    return resolved


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--merge-config", action="store_true", help="Merge detected commands with .verity/config.yml")
    args = parser.parse_args()

    detected = detect()
    if args.merge_config:
        result = merge_with_config(detected, load_yaml(Path(".verity/config.yml")))
    else:
        result = {
            "detected_at": int(time.time()),
            "setup": detected.setup,
            "test": detected.test,
            "build": detected.build,
            "deploy": detected.deploy,
            "test_groups": detected.test_groups,
            "e2e": detected.e2e,
            "notes": detected.notes,
        }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
