# Verity Codex PR Auto-Fix

You are repairing a pull request branch after the repository's full detected test suite failed.

Rules:
- Follow `AGENTS.md` and `.verity/config.yml`.
- Fix the underlying issue with minimal, production-safe changes.
- You may update existing tests if the PR intentionally changed behavior.
- You may add new tests when the new code needs coverage.
- Do not weaken assertions or delete meaningful coverage just to make CI pass.
- Keep the branch green against the resolved test suite, including integration and E2E when runnable.

Required steps:
1) Read `AGENTS.md`, `.verity/config.yml`, and the failure context attached to this run.
2) Fix the failing code and any test gaps needed to reflect intended behavior.
3) If `policies.documentation.auto_mode` is enabled, run `python scripts/sync_repo_docs.py`.
4) Run the provided setup/test/build commands until green.
5) Final message: root cause, files changed, tests updated/added, commands run.
