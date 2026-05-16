#!/usr/bin/env python3
"""
mine-tests.py — Test Mining for the 8-pass pipeline (Pass 4)

Goes deeper than Pass 1's test extraction:
  - Groups test descriptions by service/feature area
  - Maps test files to source files via naming + mock imports
  - Extracts mock dependencies (jest.mock / unittest.mock / etc.)
  - Generates human-readable requirement summaries from test clusters

Output: Appends ## TEST-DERIVED REQUIREMENTS to code-inventory.md

Runs on: GitHub Actions runner (before Codex step, after extract-code-inventory.py)
"""

import os
import re
import sys
from pathlib import Path
from collections import defaultdict

REPO_ROOT = Path(os.environ.get("GITHUB_WORKSPACE", ".")).resolve()
INVENTORY_FILE = REPO_ROOT / "code-inventory.md"

# Exclude dirs
EXCLUDE_DIRS = {
    "node_modules", ".git", "dist", "build", "__pycache__", ".next",
    "coverage", ".nyc_output", "vendor", "target", ".gradle",
    "dist__prebuild_backup", ".verity", ".github"
}

MAX_FILES = 500


def log(msg: str):
    print(f"[mine-tests] {msg}", file=sys.stderr)


def find_files(patterns: list[str]) -> list[Path]:
    results = []
    for pattern in patterns:
        for p in REPO_ROOT.rglob(pattern):
            if any(part in EXCLUDE_DIRS for part in p.relative_to(REPO_ROOT).parts):
                continue
            if p.is_file():
                results.append(p)
            if len(results) >= MAX_FILES:
                break
    return sorted(set(results))


def read_safe(path: Path) -> str:
    try:
        if path.stat().st_size > 500_000:
            return ""
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


# ---------------------------------------------------------------------------
# Find test files (same logic as extract-code-inventory.py)
# ---------------------------------------------------------------------------
def find_test_files() -> list[Path]:
    test_files = []
    for pattern in [
        "*.test.ts", "*.test.js", "*.test.tsx", "*.test.jsx",
        "*.spec.ts", "*.spec.js", "*.spec.tsx", "*.spec.jsx",
        "test_*.py", "*_test.py", "*_test.go",
        "*Test.java", "*Test.kt", "*_spec.rb",
    ]:
        test_files.extend(find_files([pattern]))

    for folder in ["__tests__", "tests", "test", "spec", "src/test"]:
        full = REPO_ROOT / folder
        if full.is_dir():
            for ext in ["*.ts", "*.js", "*.py", "*.java", "*.go", "*.rb"]:
                for f in full.rglob(ext):
                    if any(part in EXCLUDE_DIRS for part in f.relative_to(REPO_ROOT).parts):
                        continue
                    if f not in test_files and f.is_file():
                        test_files.append(f)

    return sorted(set(test_files))[:MAX_FILES]


# ---------------------------------------------------------------------------
# Extract mock dependencies (JS/TS jest.mock)
# ---------------------------------------------------------------------------
def extract_js_mocks(content: str) -> list[str]:
    """Extract mocked module paths from jest.mock() calls."""
    mock_re = re.compile(r"""jest\.mock\s*\(\s*['"]([^'"]+)['"]""")
    return [m.group(1) for m in mock_re.finditer(content)]


# ---------------------------------------------------------------------------
# Map test file → source file
# ---------------------------------------------------------------------------
def infer_source_file(test_path: Path) -> str | None:
    """Try to map a test file to its source file by naming convention."""
    name = test_path.stem

    # Remove test suffixes: foo.test → foo, foo.spec → foo, foo.unit.test → foo
    source_name = re.sub(r"\.(test|spec|unit\.test|integration\.test|e2e\.test)$", "", name)

    if source_name == name:
        # Python: test_foo → foo, foo_test → foo
        source_name = re.sub(r"^test_", "", name)
        source_name = re.sub(r"_test$", "", source_name)

    if source_name == name:
        # Java: FooTest → Foo, FooTests → Foo
        source_name = re.sub(r"Tests?$", "", name)

    if source_name == name:
        return None

    # Search for matching source file
    for ext in [".ts", ".js", ".tsx", ".py", ".java", ".go", ".rb", ".kt"]:
        candidates = list(REPO_ROOT.rglob(f"{source_name}{ext}"))
        candidates = [c for c in candidates
                      if not any(part in EXCLUDE_DIRS for part in c.relative_to(REPO_ROOT).parts)
                      and "test" not in c.name.lower() and "spec" not in c.name.lower()]
        if candidates:
            return rel(candidates[0])

    return None


# ---------------------------------------------------------------------------
# Parse test file deeply
# ---------------------------------------------------------------------------
def parse_test_file(path: Path) -> dict:
    """Parse a test file and extract structured information."""
    content = read_safe(path)
    if not content:
        return {}

    file_rel = rel(path)
    result = {
        "file": file_rel,
        "source_file": infer_source_file(path),
        "mocks": [],
        "suites": [],
    }

    if path.suffix in (".ts", ".js", ".tsx", ".jsx", ".mjs"):
        # Extract mocks
        result["mocks"] = extract_js_mocks(content)

        # Extract describe/it structure
        describe_re = re.compile(r"""(?:describe|context)\s*\(\s*['"`](.+?)['"`]""")
        it_re = re.compile(r"""(?:it|test)\s*\(\s*['"`](.+?)['"`]""")

        current_suite = None
        suites = defaultdict(list)

        for line in content.splitlines():
            dm = describe_re.search(line)
            if dm:
                current_suite = dm.group(1)
            im = it_re.search(line)
            if im:
                suite_name = current_suite or file_rel
                suites[suite_name].append(im.group(1))

        result["suites"] = [{"name": k, "tests": v} for k, v in suites.items()]

    elif path.suffix == ".py":
        py_class_re = re.compile(r"""class\s+(Test\w+)""")
        py_func_re = re.compile(r"""def\s+(test_\w+)""")
        mock_re = re.compile(r"""@(?:mock\.)?patch\s*\(\s*['"]([^'"]+)['"]""")

        result["mocks"] = [m.group(1) for m in mock_re.finditer(content)]

        current_class = None
        suites = defaultdict(list)
        for line in content.splitlines():
            cm = py_class_re.search(line)
            if cm:
                current_class = cm.group(1)
            fm = py_func_re.search(line)
            if fm:
                suite_name = current_class or file_rel
                suites[suite_name].append(fm.group(1).replace("_", " "))
        result["suites"] = [{"name": k, "tests": v} for k, v in suites.items()]

    elif path.suffix in (".java", ".kt"):
        display_re = re.compile(r"""@DisplayName\s*\(\s*"(.+?)"\s*\)""")
        method_re = re.compile(r"""@Test\s+.*?(?:void|public|fun)\s+(\w+)\s*\(""", re.DOTALL)
        tests = [m.group(1) for m in display_re.finditer(content)]
        if not tests:
            tests = [m.group(1) for m in method_re.finditer(content)]
        if tests:
            result["suites"] = [{"name": path.stem, "tests": tests}]

    elif path.suffix == ".go":
        go_re = re.compile(r"""func\s+(Test\w+)\s*\(""")
        tests = [m.group(1) for m in go_re.finditer(content)]
        if tests:
            result["suites"] = [{"name": file_rel, "tests": tests}]

    elif path.suffix == ".rb":
        rb_desc_re = re.compile(r"""(?:describe|context)\s+['"](.+?)['"]""")
        rb_it_re = re.compile(r"""it\s+['"](.+?)['"]""")
        current_desc = None
        suites = defaultdict(list)
        for line in content.splitlines():
            dm = rb_desc_re.search(line)
            if dm:
                current_desc = dm.group(1)
            im = rb_it_re.search(line)
            if im:
                suites[current_desc or file_rel].append(im.group(1))
        result["suites"] = [{"name": k, "tests": v} for k, v in suites.items()]

    return result


# ---------------------------------------------------------------------------
# Generate requirement summaries from test clusters
# ---------------------------------------------------------------------------
def summarize_requirements(parsed_files: list[dict]) -> list[dict]:
    """Group tests by feature area and generate requirement summaries."""
    requirements = []

    for pf in parsed_files:
        if not pf or not pf.get("suites"):
            continue

        for suite in pf["suites"]:
            tests = suite.get("tests", [])
            if not tests:
                continue

            suite_name = suite["name"]
            test_count = len(tests)

            # Extract key verbs/behaviors from test descriptions
            behaviors = []
            for t in tests:
                # Normalize: "should acquire lock" → "acquire lock"
                clean = re.sub(r"^should\s+", "", t, flags=re.IGNORECASE)
                clean = re.sub(r"^it\s+", "", clean, flags=re.IGNORECASE)
                clean = re.sub(r"^test\s+", "", clean, flags=re.IGNORECASE)
                behaviors.append(clean)

            # Build a summary
            if test_count == 1:
                summary = f"System {behaviors[0]}"
            elif test_count <= 4:
                summary = f"System supports: {'; '.join(behaviors)}"
            else:
                # Summarize first few + count
                summary = f"System supports: {'; '.join(behaviors[:3])}; and {test_count - 3} more behaviors"

            requirements.append({
                "feature": suite_name,
                "summary": summary,
                "test_count": test_count,
                "test_file": pf["file"],
                "source_file": pf.get("source_file"),
                "mocks": pf.get("mocks", []),
                "test_descriptions": behaviors[:10],  # Cap for readability
            })

    return requirements


# ---------------------------------------------------------------------------
# Append to code-inventory.md
# ---------------------------------------------------------------------------
def append_to_inventory(requirements: list[dict]):
    """Append TEST-DERIVED REQUIREMENTS section to code-inventory.md."""
    if not INVENTORY_FILE.exists():
        log(f"WARNING: {INVENTORY_FILE} does not exist. Skipping append.")
        return

    lines = [
        "",
        f"## Test-Derived Requirements ({len(requirements)} feature areas from test analysis)",
        "",
    ]

    if not requirements:
        lines.append("_No test-derived requirements extracted._")
    else:
        for req in requirements:
            lines.append(f"### {req['feature']}")
            lines.append(f"**{req['summary']}**")
            lines.append(f"- Test file: `{req['test_file']}` ({req['test_count']} tests)")
            if req["source_file"]:
                lines.append(f"- Source file: `{req['source_file']}`")
            if req["mocks"]:
                lines.append(f"- Dependencies mocked: {', '.join(f'`{m}`' for m in req['mocks'][:5])}")
            lines.append(f"- Behaviors tested:")
            for b in req["test_descriptions"]:
                lines.append(f"  - {b}")
            lines.append("")

    existing = INVENTORY_FILE.read_text(encoding="utf-8")
    INVENTORY_FILE.write_text(existing + "\n".join(lines), encoding="utf-8")
    log(f"Appended {len(requirements)} requirements to {INVENTORY_FILE}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    log(f"Scanning for test files in {REPO_ROOT}")

    test_files = find_test_files()
    log(f"Found {len(test_files)} test files")

    if not test_files:
        log("No test files found. Nothing to mine.")
        append_to_inventory([])
        return

    log("Parsing test files...")
    parsed = []
    for f in test_files:
        result = parse_test_file(f)
        if result and result.get("suites"):
            parsed.append(result)

    log(f"Parsed {len(parsed)} files with test suites")

    # Log mock/source mapping stats
    with_source = sum(1 for p in parsed if p.get("source_file"))
    with_mocks = sum(1 for p in parsed if p.get("mocks"))
    log(f"  Mapped to source file: {with_source}/{len(parsed)}")
    log(f"  Has mock dependencies: {with_mocks}/{len(parsed)}")

    log("Generating requirement summaries...")
    requirements = summarize_requirements(parsed)
    log(f"Generated {len(requirements)} requirement summaries")

    log("Appending to code-inventory.md...")
    append_to_inventory(requirements)

    log("Done!")


if __name__ == "__main__":
    main()
