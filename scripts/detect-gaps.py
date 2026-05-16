#!/usr/bin/env python3
"""
detect-gaps.py — Gap Detection for the 8-pass pipeline (Pass 6)

Runs AFTER Codex generates stories. Compares:
  - Routes/pages/tests in code-inventory.md (what exists in the code)
  - Routes/pages/tests mentioned in generated-stories.json (what stories cover)

Reports:
  - Uncovered routes (routes with no corresponding story)
  - Uncovered pages (pages with no corresponding story)
  - Uncovered test behaviors (tests with no corresponding story)
  - Coverage percentages

Output: Writes coverage-gaps.json (included in callback payload)

Runs on: GitHub Actions runner (after story extraction, before callback)
"""

import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(os.environ.get("GITHUB_WORKSPACE", ".")).resolve()
INVENTORY_FILE = REPO_ROOT / "code-inventory.md"
STORIES_FILE = REPO_ROOT / "generated-stories.json"
OUTPUT_FILE = REPO_ROOT / "coverage-gaps.json"


def log(msg: str):
    print(f"[detect-gaps] {msg}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Parse code-inventory.md to extract known routes, pages, tests
# ---------------------------------------------------------------------------
def parse_inventory() -> dict:
    """Extract routes, pages, and test descriptions from code-inventory.md."""
    if not INVENTORY_FILE.exists():
        log(f"WARNING: {INVENTORY_FILE} not found")
        return {"routes": [], "pages": [], "tests": []}

    content = INVENTORY_FILE.read_text(encoding="utf-8")

    routes = []
    pages = []
    tests = []

    current_section = None

    for line in content.splitlines():
        # Detect section headers
        if line.startswith("## API Endpoints"):
            current_section = "routes"
            continue
        elif line.startswith("## Frontend Pages"):
            current_section = "pages"
            continue
        elif line.startswith("## Test Behaviors"):
            current_section = "tests"
            continue
        elif line.startswith("## "):
            current_section = None
            continue

        line_stripped = line.strip()
        if not line_stripped or line_stripped.startswith("#"):
            continue

        if current_section == "routes" and line_stripped.startswith("- "):
            # Parse: "- GET     /test-cases"
            route_match = re.match(r"-\s+(GET|POST|PUT|PATCH|DELETE|ANY|HEAD|OPTIONS)\s+(\S+)", line_stripped)
            if route_match:
                routes.append({
                    "method": route_match.group(1),
                    "path": route_match.group(2),
                    "raw": line_stripped,
                })

        elif current_section == "pages" and line_stripped.startswith("- "):
            # Parse: "- `/dashboard` -> Dashboard (file.tsx)"
            page_match = re.match(r"-\s+`([^`]+)`", line_stripped)
            if page_match:
                pages.append({
                    "path": page_match.group(1),
                    "raw": line_stripped,
                })

        elif current_section == "tests" and line_stripped.startswith("- "):
            # Parse: "- should acquire lock with unique token"
            test_desc = line_stripped.lstrip("- ").strip()
            if test_desc and not test_desc.startswith("Button labels:"):
                tests.append({
                    "description": test_desc,
                    "raw": line_stripped,
                })

    return {"routes": routes, "pages": pages, "tests": tests}


# ---------------------------------------------------------------------------
# Parse generated stories
# ---------------------------------------------------------------------------
def parse_stories() -> list[dict]:
    """Load generated stories from JSON file."""
    if not STORIES_FILE.exists():
        log(f"WARNING: {STORIES_FILE} not found")
        return []

    try:
        return json.loads(STORIES_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, Exception) as e:
        log(f"WARNING: Failed to parse {STORIES_FILE}: {e}")
        return []


# ---------------------------------------------------------------------------
# Build searchable text from stories
# ---------------------------------------------------------------------------
def build_story_corpus(stories: list[dict]) -> str:
    """Combine all story text into one searchable corpus."""
    parts = []
    for s in stories:
        parts.append(s.get("title", ""))
        parts.append(s.get("description", ""))
        for c in s.get("acceptanceCriteria", []):
            parts.append(c)
    return " ".join(parts).lower()


# ---------------------------------------------------------------------------
# Match routes/pages/tests against story corpus
# ---------------------------------------------------------------------------
def check_route_coverage(routes: list[dict], corpus: str) -> dict:
    """Check which routes are mentioned in stories."""
    covered = []
    uncovered = []

    for r in routes:
        path = r["path"]
        # Normalize path for matching: /test-cases/{id} → test-cases, test cases
        path_words = re.sub(r"[/{}\-_:.]", " ", path).strip().lower()
        path_segments = [s for s in path_words.split() if len(s) > 2 and s not in ("api", "id", "org", "project")]

        # A route is "covered" if at least one meaningful path segment appears in stories
        is_covered = False
        if path_segments:
            for seg in path_segments:
                if seg in corpus:
                    is_covered = True
                    break

        if is_covered:
            covered.append(r)
        else:
            uncovered.append(r)

    return {"covered": covered, "uncovered": uncovered}


def check_page_coverage(pages: list[dict], corpus: str) -> dict:
    """Check which pages are mentioned in stories."""
    covered = []
    uncovered = []

    for p in pages:
        path = p["path"]
        path_words = re.sub(r"[/\-_:.]", " ", path).strip().lower()
        path_segments = [s for s in path_words.split() if len(s) > 2 and s != "*"]

        is_covered = False
        if path_segments:
            for seg in path_segments:
                if seg in corpus:
                    is_covered = True
                    break

        if is_covered:
            covered.append(p)
        else:
            uncovered.append(p)

    return {"covered": covered, "uncovered": uncovered}


def check_test_coverage(tests: list[dict], corpus: str) -> dict:
    """Check which test behaviors are reflected in stories."""
    covered = []
    uncovered = []

    for t in tests:
        desc = t["description"].lower()
        # Extract key words (3+ chars, not common test words)
        skip_words = {"should", "test", "when", "then", "given", "with", "from", "that",
                       "the", "and", "for", "not", "can", "will", "does", "has", "are", "was"}
        words = [w for w in re.findall(r"\w{3,}", desc) if w not in skip_words]

        # Covered if at least 2 key words appear in corpus
        match_count = sum(1 for w in words if w in corpus)
        is_covered = match_count >= min(2, len(words))

        if is_covered:
            covered.append(t)
        else:
            uncovered.append(t)

    return {"covered": covered, "uncovered": uncovered}


# ---------------------------------------------------------------------------
# Write coverage report
# ---------------------------------------------------------------------------
def write_report(
    route_result: dict,
    page_result: dict,
    test_result: dict,
    total_stories: int,
):
    """Write coverage-gaps.json with gap analysis."""
    total_routes = len(route_result["covered"]) + len(route_result["uncovered"])
    total_pages = len(page_result["covered"]) + len(page_result["uncovered"])
    total_tests = len(test_result["covered"]) + len(test_result["uncovered"])

    route_coverage = (len(route_result["covered"]) / total_routes * 100) if total_routes else 0
    page_coverage = (len(page_result["covered"]) / total_pages * 100) if total_pages else 0
    test_coverage = (len(test_result["covered"]) / total_tests * 100) if total_tests else 0

    report = {
        "summary": {
            "total_stories": total_stories,
            "route_coverage_pct": round(route_coverage, 1),
            "page_coverage_pct": round(page_coverage, 1),
            "test_coverage_pct": round(test_coverage, 1),
            "routes_total": total_routes,
            "routes_covered": len(route_result["covered"]),
            "routes_uncovered": len(route_result["uncovered"]),
            "pages_total": total_pages,
            "pages_covered": len(page_result["covered"]),
            "pages_uncovered": len(page_result["uncovered"]),
            "tests_total": total_tests,
            "tests_covered": len(test_result["covered"]),
            "tests_uncovered": len(test_result["uncovered"]),
        },
        "uncovered_routes": [
            f"{r['method']} {r['path']}" for r in route_result["uncovered"][:50]
        ],
        "uncovered_pages": [
            p["path"] for p in page_result["uncovered"][:20]
        ],
        "uncovered_tests": [
            t["description"] for t in test_result["uncovered"][:50]
        ],
    }

    OUTPUT_FILE.write_text(json.dumps(report, indent=2), encoding="utf-8")
    log(f"Wrote gap report to {OUTPUT_FILE}")

    return report


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    log("Starting gap detection...")

    log("Parsing code-inventory.md...")
    inventory = parse_inventory()
    log(f"  Routes: {len(inventory['routes'])}")
    log(f"  Pages: {len(inventory['pages'])}")
    log(f"  Tests: {len(inventory['tests'])}")

    log("Parsing generated-stories.json...")
    stories = parse_stories()
    log(f"  Stories: {len(stories)}")

    if not stories:
        log("No stories found. Writing empty gap report.")
        report = {
            "summary": {
                "total_stories": 0,
                "route_coverage_pct": 0,
                "page_coverage_pct": 0,
                "test_coverage_pct": 0,
            },
            "uncovered_routes": [],
            "uncovered_pages": [],
            "uncovered_tests": [],
        }
        OUTPUT_FILE.write_text(json.dumps(report, indent=2), encoding="utf-8")
        log("Done (no stories to compare against).")
        return

    log("Building story corpus...")
    corpus = build_story_corpus(stories)
    log(f"  Corpus size: {len(corpus)} chars")

    log("Checking route coverage...")
    route_result = check_route_coverage(inventory["routes"], corpus)
    log(f"  Covered: {len(route_result['covered'])}, Uncovered: {len(route_result['uncovered'])}")

    log("Checking page coverage...")
    page_result = check_page_coverage(inventory["pages"], corpus)
    log(f"  Covered: {len(page_result['covered'])}, Uncovered: {len(page_result['uncovered'])}")

    log("Checking test coverage...")
    test_result = check_test_coverage(inventory["tests"], corpus)
    log(f"  Covered: {len(test_result['covered'])}, Uncovered: {len(test_result['uncovered'])}")

    log("Writing gap report...")
    report = write_report(route_result, page_result, test_result, len(stories))

    # Print summary
    s = report["summary"]
    log(f"")
    log(f"=== COVERAGE SUMMARY ===")
    log(f"  Stories generated:    {s['total_stories']}")
    log(f"  Route coverage:       {s['route_coverage_pct']}% ({s['routes_covered']}/{s['routes_total']})")
    log(f"  Page coverage:        {s['page_coverage_pct']}% ({s['pages_covered']}/{s['pages_total']})")
    log(f"  Test coverage:        {s['test_coverage_pct']}% ({s['tests_covered']}/{s['tests_total']})")
    log(f"  Uncovered routes:     {s['routes_uncovered']}")
    log(f"  Uncovered pages:      {s['pages_uncovered']}")
    log(f"  Uncovered tests:      {s['tests_uncovered']}")
    log(f"========================")

    log("Done!")


if __name__ == "__main__":
    main()
