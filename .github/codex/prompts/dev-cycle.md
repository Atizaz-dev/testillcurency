# Verity Codex Dev Cycle

Follow `AGENTS.md` and `.verity/config.yml`.

Do NOT commit/push/open PR yourself. Leave changes in the working tree; the workflow creates the PR.

## CRITICAL: You must EXECUTE file writes — do not just describe them

The sandbox environment may not preserve heredoc or shell-redirect writes reliably.
**Always write files using Python so content is guaranteed to be on disk:**

```python
from pathlib import Path
Path("path/to/file").parent.mkdir(parents=True, exist_ok=True)
Path("path/to/file").write_text("""
<full file content here>
""".lstrip(), encoding="utf-8")
```

After every file write, **verify** the file exists and has non-trivial content.

**CRITICAL: Always read a file before overwriting it.** If you are modifying an existing file, read its current content first, then write the updated version.

## Required steps

1) Read `AGENTS.md` and `.verity/config.yml` to understand the project layout, commands, and policies.

2) Implement the request with minimal, production-safe changes.

3) If `policies.documentation.auto_mode` is enabled, run `python scripts/sync_repo_docs.py`.

4) Run the resolved Verity test/build suite, including grouped test commands when present. Fix code failures until green.

5) Update existing tests when the intended behavior changed, and add new tests when new logic needs coverage. Never weaken assertions just to make CI pass.

6) **Write a Playwright browser test** for the feature or fix you just implemented:
   - Look for an existing `e2e/` directory or `playwright.config.ts` in the project. Create the test file there (e.g., `e2e/<feature-name>.spec.ts` or `tests/e2e/<feature-name>.spec.ts`).
   - Import from `@playwright/test`: `import { test, expect } from '@playwright/test';`
   - Test the SPECIFIC feature or fix you built — not the entire application.
   - Verify the complete user flow: navigation, interactions, expected outcomes.
   - Use relative paths for navigation (e.g., `await page.goto('/dashboard')`) — the base URL is set by the workflow via `PLAYWRIGHT_BASE_URL`.
   - If the feature requires authentication, check for `VERITY_E2E_EMAIL` and `VERITY_E2E_PASSWORD` env vars and skip if not set:
     ```typescript
     test.beforeEach(async () => {
       if (!process.env.VERITY_E2E_EMAIL) test.skip(true, 'E2E credentials not configured');
     });
     ```
   - The workflow will start local servers and run your test automatically after your code changes.

7) Final message must include:
   - Which source files were changed and a brief rationale for each.
   - Test and build commands run and their outcomes.
   - If no code change was possible, explain specifically why.
