# Verity Repo Context Builder (Reference)

This repo includes an automated workflow `.github/workflows/verity-repo-context-builder.yml` that:
- detects likely setup/test/build/deploy commands
- updates `docs/REPO_CONTEXT.md`
- fills empty `commands.*` arrays in `.verity/config.yml` (only when empty)
- opens a PR for human review

It may also include `.github/workflows/verity-auto-docs.yml` plus `scripts/sync_repo_docs.py` to keep:
- `docs/REPO_CONTEXT.md`
- `docs/AI_HANDOFF.md`
fresh as code evolves.

If you modify repository structure, keep this workflow working for noob developers.
