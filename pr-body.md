This PR was created automatically by Verity/Codex.

- Workflow run: https://github.com/Atizaz-dev/testillcurency/actions/runs/25972816147
- Issue: 3

## Browser test status

> **Browser tests skipped**: Local servers could not start or Playwright was not available.

## Codex summary

Work completed. I implemented a minimal, production-safe “Forgot password?” entry point on the sign-in screen and added an e2e test, following AGENTS.md and .verity/config.yml.

**Changes Made**
- public/index.html
  - Inserted a “Forgot password?” link directly beneath the sign-in form. It reuses existing button styles and opens a WhatsApp message to support so the user can request a password reset.
  - Rationale: The repo already uses WhatsApp for signup support; aligning password reset entry with the same channel avoids backend changes and stays minimal.

- e2e/forgot-password.spec.ts
  - New Playwright test that navigates to “/”, verifies the link is visible, and checks that its `href` points to a WhatsApp `wa.me` URL and contains the expected text.
  - Rationale: Focused test coverage for the newly added UI element as required.

- docs/AI_HANDOFF.md, docs/REPO_CONTEXT.md
  - Updated by running the docs sync script because policies.documentation.auto_mode is true.

**What I did not change**
- No backend API or data model modifications. The admin page already has password reset; the new UI simply surfaces the contact path for non-admin users.
- No new dependencies introduced.

**Commands Run and Outcomes**
- Docs sync (required by auto_mode):
  - Command: `python scripts/sync_repo_docs.py`
  - Outcome: Completed; updated docs/REPO_CONTEXT.md and docs/AI_HANDOFF.md (reported as SYNC_DONE).

- Repo tests/build (per .verity/config.yml):
  - .verity/config.yml lists empty `commands.test` and `commands.build`. There are no configured scripts to run locally, so there was nothing to execute here.

**Verification**
- File writes were executed via Python and verified on disk.
- Content presence check:
  - Added link id: `#forgotPasswordBtn`
  - E2E test created at `e2e/forgot-password.spec.ts`

**Notes**
- The link uses the same WhatsApp contact number and pattern used elsewhere in the repo.
- If you prefer an inline reset flow (email token), we can add a lightweight backend endpoint and update the UI accordingly, but this would expand scope beyond the current minimal request.

If you want, I can:
- Wire a mailto fallback for non-WhatsApp users.
- Add aria-live hint text for better a11y when the link appears.
