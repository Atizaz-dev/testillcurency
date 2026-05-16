#!/usr/bin/env python3
import os
import sys
from pathlib import Path

# Patterns to detect
BAD_SUBSTRINGS = [
    "import openai",
    "from openai",
    "api.openai.com",
]

REQUIRED_WORKFLOWS = [
    "codex-dev-cycle.yml",
    "codex-pr-review.yml",
    "codex-test-generation.yml",
    "codex-usecase-generation.yml",
    "codex-test-to-issue.yml",
    "codex-deploy.yml",
    "verity-pr-auto-fix.yml",
    "verity-post-merge-validation.yml",
    "verity-auto-docs.yml",
    "verity-repo-context-builder.yml",
    "verity-guardrails.yml",
    "verity-monitor.yml",
    "verity-command-router.yml",
]

# Template tokens and shared Verity staging defaults must not ship in customer repos.
VERITY_STAGING_GITHUB_ACTIONS_CALLBACK = (
    "https://szfu8h6spk.execute-api.us-east-1.amazonaws.com/staging/api/callbacks/github-actions"
)

PLACEHOLDER_BLOCKLIST = [
    "https://szfu8h6spk.execute-api.us-east-1.amazonaws.com/staging/api/callbacks/github-actions",
    "4eed32cc-56ab-4d04-97c4-58a0d71326da",
    "v2",
    VERITY_STAGING_GITHUB_ACTIONS_CALLBACK,
]

# Allowlist prefixes (repo-relative, forward-slash)
ALLOW_PREFIXES = [
    ".github/",
    "docs/openai-usage-inventory.md",
    "scripts/check_no_direct_openai.py",
    "verity_templates/bootstrap/v2/scripts/check_no_direct_openai.py",
    "backend/verity_templates/bootstrap/v2/scripts/check_no_direct_openai.py",
    "backend/services/bootstrapTemplatePacks.ts",
    # Provider locations (customize per repo; safe defaults)
    "backend/src/ai/",
    "backend/src/ai_provider.py",
    "backend/services/ai/",
    "backend/services/utils/aiClient.ts",
]

def is_allowed(rel: str) -> bool:
    rel = rel.replace("\\", "/")
    return any(rel == p or rel.startswith(p) for p in ALLOW_PREFIXES)

def main() -> int:
    root = Path(".").resolve()
    offenders = []
    required_file_errors = []
    placeholder_errors = []

    workflows_dir = root / ".github" / "workflows"
    for workflow in REQUIRED_WORKFLOWS:
        if not (workflows_dir / workflow).exists():
            required_file_errors.append(f".github/workflows/{workflow}")

    bootstrap_path = root / ".verity" / "bootstrap.json"
    bootstrap_text = ""
    if bootstrap_path.exists():
        bootstrap_text = bootstrap_path.read_text(encoding="utf-8", errors="ignore")
    template_source_repo = "__INSTALLED_FILES__" in bootstrap_text

    config_path = root / ".verity" / "config.yml"
    if config_path.exists() and not template_source_repo:
        config_text = config_path.read_text(encoding="utf-8", errors="ignore")
        for placeholder in PLACEHOLDER_BLOCKLIST:
            if placeholder in config_text:
                placeholder_errors.append(
                    f"{config_path.relative_to(root)} still contains placeholder {placeholder}"
                )

    for path in root.rglob("*"):
        if path.is_dir():
            continue
        # skip common binaries/large dirs
        rel = str(path.relative_to(root)).replace("\\", "/")
        if any(part in rel for part in [".git/", "node_modules/", ".venv/", "dist/", "build/"]):
            continue
        # only scan text-like files
        if path.suffix.lower() in [".png",".jpg",".jpeg",".gif",".pdf",".zip",".gz",".tar",".mp4",".mov",".mp3",".wav",".woff",".woff2",".ttf",".eot"]:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        for bad in BAD_SUBSTRINGS:
            if bad in text:
                if not is_allowed(rel):
                    offenders.append((rel, bad))

    has_errors = bool(offenders or required_file_errors or placeholder_errors)
    if required_file_errors:
        print("Missing required workflow files:", file=sys.stderr)
        for rel in required_file_errors:
            print(f" - {rel}", file=sys.stderr)

    if placeholder_errors:
        print("Bootstrap placeholders still present in .verity/config.yml:", file=sys.stderr)
        for msg in placeholder_errors:
            print(f" - {msg}", file=sys.stderr)
        print(
            "Hint: set verity.project_id and verity.callback_url from your Verity project "
            "(not template strings or the shared staging callback URL).",
            file=sys.stderr,
        )

    if offenders:
        print("Direct OpenAI usage detected outside allowlist:", file=sys.stderr)
        for rel, bad in offenders:
            print(f" - {rel} (matched: {bad})", file=sys.stderr)
        return 1
    if has_errors:
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
