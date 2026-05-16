# Verity Codex: Convert failing tests to a GitHub Issue

Read `test-output.txt`, identify the failure, and produce `issue.json` matching the schema:
`.github/codex/schemas/issue.schema.json`

Issue body must include:
- What failed
- Steps to reproduce (commands)
- Expected vs actual
- Suggested fix approach
- Likely impacted files/modules
