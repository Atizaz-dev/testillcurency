# Verity Codex Test Generation

Generate/update tests to reflect intended behavior and prevent regressions.

Rules:
- Follow `AGENTS.md`.
- Prefer adding tests over changing production code.
- Keep scope minimal.
- Update existing tests when intended behavior changed.
- Do not weaken assertions just to make CI pass.

Steps:
1) Read `.verity/config.yml` to learn test/build commands.
2) Add/update tests, including existing tests that no longer match intended behavior.
3) If `policies.documentation.auto_mode` is enabled, run `python scripts/sync_repo_docs.py`.
4) Run tests/build until green.
5) Final message: Summary, tests added, commands run.
