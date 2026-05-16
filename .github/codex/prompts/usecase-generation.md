# Verity Codex Use-Case Generation

Generate ALL user stories for this codebase and write them to `docs/use-cases.md`.

**IMPORTANT:** Do NOT "update" or edit the existing file. Generate a FRESH, COMPLETE set of
user stories by analyzing the full codebase. The deduplication system will handle duplicates.

## What these stories are used for

These stories drive a FULLY AUTOMATED QA pipeline:

```
Story → AI generates test cases (positive, negative, edge, permission)
  → AI generates Playwright test script + spec file for each test case
    → Playwright runs the test
      → If test FAILS: AI reads the spec file + recent git commits
        → AI determines: is it a real bug or did the code change?
        → AI fixes the test script or reports the bug
```

Each story you write will produce 8-15 automated test cases.
Each test case will become a real Playwright browser test.
The STRONGER and more SPECIFIC your stories are, the better
the test coverage will be. Vague stories produce weak tests.

## Discovery guidance

The file `code-inventory.md` (if present in the repo root) contains a pre-extracted inventory
of API endpoints, frontend pages, test behaviors, UI interactions, and user flows.
**Read it FIRST** — it tells you every feature that exists. Then browse the actual source
files for details.

For each item in code-inventory.md, there should be at least one user story.
Additionally, scan the codebase for anything code-inventory.md may have missed:
- **API routes / endpoints** — route files, controllers, Lambda handlers, decorator-based routes
- **Frontend pages & routes** — router configs (React Router, Vue Router, Angular, Next.js pages)
- **UI interactions** — buttons, forms, event handlers (onClick, onSubmit, @click)
- **Test descriptions** — describe/it/test blocks reveal expected behaviors
- **Service methods** — public methods in service classes show business capabilities

## Story format

You are analyzing an EXISTING, ALREADY-BUILT application. All the code is there.

Write one story per FEATURE or WORKFLOW.
Do not split a single feature into multiple stories.
Do not merge DIFFERENT features into one story.

For each story use this exact format (### heading per story):

### [Story Title]

**Description:** Describe WHO uses this feature (role or system component),
WHAT it does, and WHY it matters. Write naturally — do not force a template.

**Related Files:**
- Frontend: `path/to/page.tsx`
- API: `METHOD /api/path`
- API client: `path/to/service.ts` → `functionName()`
- Backend: `path/to/handler.ts`
- State: `path/to/store.ts`

**Upstream:** [what triggers this — which page, which button, which link]
**Downstream:** [what happens next — redirect, side effect, notification]

**Acceptance Criteria:**

Positive:
- Given [precondition], When [action], Then [expected result]
- Given [precondition], When [action], Then [expected result]
- Given [precondition], When [action], Then [expected result]

Negative:
- Given [error condition], When [action fails], Then [error handling]
- Given [invalid input], When [submitted], Then [validation message]

Edge:
- Given [boundary condition], When [action], Then [graceful handling]
- Given [empty/large dataset], When [page loads], Then [appropriate behavior]

Permission:
- Given [wrong role], When [accessing this feature], Then [access denied/redirect]

**Priority:** high/medium/low
**Tags:** [comma-separated tags]

## Coverage rules

**Role-based:** If the app has multiple roles with separate pages or different views,
write a SEPARATE story for each role. "Admin views POs" and "Vendor views POs" are
TWO stories — different permissions, data, and UI.

**Page coverage:** Every frontend page must have at least one story.

**API coverage:** Every API endpoint group must be covered.

**Test coverage:** Every test behavior group should map to a story.

Do not stop until you have covered every feature in the codebase.

Follow `AGENTS.md`. Do not include secrets.

If `policies.documentation.auto_mode` is enabled, also refresh docs context using:
- `python scripts/sync_repo_docs.py`
