#!/usr/bin/env python3
"""
extract-code-inventory.py — Static extraction for the 8-pass pipeline (Pass 1)

Scans a checked-out codebase and extracts:
  - Tech stack (frameworks, languages, test runners)
  - API routes / endpoints (any framework)
  - Frontend pages & routes (any SPA router)
  - Test descriptions (any test framework)
  - UI interactions (buttons, forms, event handlers)
  - Frontend API calls (HTTP client calls)

Output: code-inventory.md — a structured inventory file that Codex reads
        before generating user stories.

Runs on: GitHub Actions runner (Ubuntu VM, before Codex step)
Dependencies: Python 3.9+, optionally ast-grep CLI
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from collections import defaultdict

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
REPO_ROOT = Path(os.environ.get("GITHUB_WORKSPACE", ".")).resolve()
OUTPUT_FILE = REPO_ROOT / "code-inventory.md"
AST_GREP_BIN = shutil.which("sg") or shutil.which("ast-grep")

# Directories to exclude from scanning
_EXCLUDE = {
    "node_modules", ".git", "dist", "build", "__pycache__", ".next",
    "coverage", ".nyc_output", "vendor", "target", ".gradle",
    "dist__prebuild_backup", ".verity", ".github"
}

# Max files to scan per category (safety net for huge monorepos)
MAX_FILES_PER_GLOB = 500


def log(msg: str):
    print(f"[extract-inventory] {msg}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def find_files(patterns: list[str], exclude_dirs: list[str] | None = None) -> list[Path]:
    """Find files matching glob patterns under REPO_ROOT, excluding common junk."""
    exclude = set(_EXCLUDE)
    if exclude_dirs:
        exclude.update(exclude_dirs)
    results = []
    for pattern in patterns:
        for p in REPO_ROOT.rglob(pattern):
            if any(part in exclude for part in p.relative_to(REPO_ROOT).parts):
                continue
            if p.is_file():
                results.append(p)
            if len(results) >= MAX_FILES_PER_GLOB:
                break
    return sorted(set(results))


def read_file_safe(path: Path, max_bytes: int = 500_000) -> str:
    """Read file content, skip if too large or binary."""
    try:
        if path.stat().st_size > max_bytes:
            return ""
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def run_ast_grep(pattern: str, lang: str, paths: list[Path]) -> list[dict]:
    """Run ast-grep and return matches. Returns empty list if ast-grep unavailable."""
    if not AST_GREP_BIN or not paths:
        return []
    try:
        file_list = [str(p) for p in paths[:100]]
        cmd = [AST_GREP_BIN, "run", "--pattern", pattern, "--lang", lang, "--json"]
        cmd.extend(file_list)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
    except Exception:
        pass
    return []


def rel(path: Path) -> str:
    """Return relative path from REPO_ROOT."""
    try:
        return str(path.relative_to(REPO_ROOT)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


# ---------------------------------------------------------------------------
# 1. Tech Stack Detection
# ---------------------------------------------------------------------------
def detect_tech_stack() -> dict:
    """Detect frameworks, languages, and tools from config files."""
    stack = {
        "languages": [],
        "backend_frameworks": [],
        "frontend_frameworks": [],
        "test_frameworks": [],
        "databases": [],
        "infrastructure": [],
    }

    # --- package.json (may exist in root or subdirs) ---
    for pkg_path in find_files(["package.json"]):
        content = read_file_safe(pkg_path)
        if not content:
            continue
        try:
            pkg = json.loads(content)
        except json.JSONDecodeError:
            continue
        all_deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}

        if any(k in all_deps for k in ["typescript", "ts-node"]):
            if "TypeScript" not in stack["languages"]:
                stack["languages"].append("TypeScript")
        if "JavaScript" not in stack["languages"]:
            stack["languages"].append("JavaScript")

        # Backend
        for name, label in [
            ("express", "Express"), ("fastify", "Fastify"),
            ("@nestjs/core", "NestJS"), ("koa", "Koa"),
            ("hapi", "Hapi"), ("@hapi/hapi", "Hapi"),
        ]:
            if name in all_deps and label not in stack["backend_frameworks"]:
                stack["backend_frameworks"].append(label)

        # Frontend
        for name, label in [
            ("react", "React"), ("vue", "Vue"), ("@angular/core", "Angular"),
            ("next", "Next.js"), ("nuxt", "Nuxt"), ("svelte", "Svelte"),
        ]:
            if name in all_deps and label not in stack["frontend_frameworks"]:
                stack["frontend_frameworks"].append(label)

        # Test
        for name, label in [
            ("jest", "Jest"), ("vitest", "Vitest"), ("mocha", "Mocha"),
            ("cypress", "Cypress"), ("playwright", "Playwright"),
            ("@testing-library/react", "React Testing Library"),
        ]:
            if name in all_deps and label not in stack["test_frameworks"]:
                stack["test_frameworks"].append(label)

    # --- Python ---
    for pyfile in ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"]:
        if (REPO_ROOT / pyfile).exists():
            if "Python" not in stack["languages"]:
                stack["languages"].append("Python")
            content = read_file_safe(REPO_ROOT / pyfile)
            for name, label in [
                ("flask", "Flask"), ("django", "Django"), ("fastapi", "FastAPI"),
                ("starlette", "Starlette"),
            ]:
                if name in content.lower() and label not in stack["backend_frameworks"]:
                    stack["backend_frameworks"].append(label)
            for name, label in [("pytest", "pytest"), ("unittest", "unittest")]:
                if name in content.lower() and label not in stack["test_frameworks"]:
                    stack["test_frameworks"].append(label)

    # --- Java ---
    for jfile in ["pom.xml", "build.gradle", "build.gradle.kts"]:
        if (REPO_ROOT / jfile).exists():
            if "Java" not in stack["languages"]:
                stack["languages"].append("Java")
            content = read_file_safe(REPO_ROOT / jfile)
            if "spring-boot" in content.lower() or "springframework" in content.lower():
                if "Spring Boot" not in stack["backend_frameworks"]:
                    stack["backend_frameworks"].append("Spring Boot")
            if "junit" in content.lower() and "JUnit" not in stack["test_frameworks"]:
                stack["test_frameworks"].append("JUnit")

    # --- Go ---
    if (REPO_ROOT / "go.mod").exists():
        if "Go" not in stack["languages"]:
            stack["languages"].append("Go")
        content = read_file_safe(REPO_ROOT / "go.mod")
        for name, label in [
            ("gin-gonic", "Go Gin"), ("labstack/echo", "Go Echo"),
            ("gorilla/mux", "Gorilla Mux"),
        ]:
            if name in content and label not in stack["backend_frameworks"]:
                stack["backend_frameworks"].append(label)
        if "Go test" not in stack["test_frameworks"]:
            stack["test_frameworks"].append("Go test")

    # --- Ruby ---
    if (REPO_ROOT / "Gemfile").exists():
        if "Ruby" not in stack["languages"]:
            stack["languages"].append("Ruby")
        content = read_file_safe(REPO_ROOT / "Gemfile")
        if "rails" in content.lower() and "Rails" not in stack["backend_frameworks"]:
            stack["backend_frameworks"].append("Rails")
        if "rspec" in content.lower() and "RSpec" not in stack["test_frameworks"]:
            stack["test_frameworks"].append("RSpec")

    # --- AWS SAM / Lambda ---
    if (REPO_ROOT / "template.yaml").exists() or (REPO_ROOT / "template.yml").exists():
        if "AWS SAM" not in stack["infrastructure"]:
            stack["infrastructure"].append("AWS SAM")
        if "Lambda" not in stack["backend_frameworks"]:
            stack["backend_frameworks"].append("Lambda")

    # --- Databases ---
    all_files_text = ""
    for pkg_path in find_files(["package.json"])[:3]:
        all_files_text += read_file_safe(pkg_path)
    for name, label in [
        ("dynamodb", "DynamoDB"), ("mongoose", "MongoDB"), ("mongodb", "MongoDB"),
        ("pg", "PostgreSQL"), ("mysql", "MySQL"), ("redis", "Redis"),
        ("prisma", "Prisma"), ("sequelize", "Sequelize"), ("typeorm", "TypeORM"),
    ]:
        if name in all_files_text.lower() and label not in stack["databases"]:
            stack["databases"].append(label)

    return stack


# ---------------------------------------------------------------------------
# 2. API Route Extraction
# ---------------------------------------------------------------------------
def extract_api_routes() -> list[dict]:
    """Extract API routes from backend code using regex patterns."""
    routes = []
    seen = set()

    def add_route(method: str, path: str, file: str, framework: str):
        key = f"{method.upper()} {path}"
        if key not in seen:
            seen.add(key)
            routes.append({"method": method.upper(), "path": path, "file": file, "framework": framework})

    # --- Express / Fastify / Koa (JS/TS) ---
    js_files = find_files(["*.ts", "*.js", "*.mjs"])
    express_re = re.compile(
        r"""(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|all|options)\s*\(\s*['"`]([^'"`]+)['"`]""",
        re.IGNORECASE
    )
    for f in js_files:
        content = read_file_safe(f)
        for m in express_re.finditer(content):
            add_route(m.group(1), m.group(2), rel(f), "Express/Fastify")

    # --- NestJS decorators ---
    nest_re = re.compile(
        r"""@(Get|Post|Put|Patch|Delete|All|Options|Head)\s*\(\s*['"`]([^'"`]*)['"`]\s*\)""",
        re.IGNORECASE
    )
    for f in js_files:
        content = read_file_safe(f)
        for m in nest_re.finditer(content):
            add_route(m.group(1), m.group(2) or "/", rel(f), "NestJS")

    # --- AWS Lambda handlers (method === 'GET' && path === '/xxx') ---
    lambda_re = re.compile(
        r"""method\s*===?\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]\s*&&\s*(?:path|event\.path)\s*===?\s*['"`]([^'"`]+)['"`]""",
        re.IGNORECASE
    )
    for f in js_files:
        content = read_file_safe(f)
        for m in lambda_re.finditer(content):
            add_route(m.group(1), m.group(2), rel(f), "Lambda")

    # --- AWS SAM template.yaml routes ---
    for tmpl_name in ["template.yaml", "template.yml"]:
        tmpl_path = REPO_ROOT / tmpl_name
        if tmpl_path.exists():
            content = read_file_safe(tmpl_path)
            sam_re = re.compile(r"Path:\s*([^\n]+)")
            method_re = re.compile(r"Method:\s*(\w+)")
            lines = content.splitlines()
            for i, line in enumerate(lines):
                pm = sam_re.search(line)
                if pm:
                    path_val = pm.group(1).strip()
                    # Look nearby for Method
                    method_val = "ANY"
                    for j in range(max(0, i - 3), min(len(lines), i + 3)):
                        mm = method_re.search(lines[j])
                        if mm:
                            method_val = mm.group(1).upper()
                            break
                    add_route(method_val, path_val, rel(tmpl_path), "SAM")

    # --- Flask / FastAPI (Python) ---
    py_files = find_files(["*.py"])
    flask_re = re.compile(
        r"""@(?:app|router|blueprint)\s*\.\s*(?:route|get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]""",
        re.IGNORECASE
    )
    for f in py_files:
        content = read_file_safe(f)
        for m in flask_re.finditer(content):
            # Try to detect method from decorator name
            dec_match = re.search(r"\.(get|post|put|patch|delete|route)\s*\(", m.group(0), re.IGNORECASE)
            method = dec_match.group(1).upper() if dec_match else "ANY"
            if method == "ROUTE":
                method = "ANY"
            add_route(method, m.group(1), rel(f), "Flask/FastAPI")

    # --- Django urls.py ---
    django_re = re.compile(
        r"""path\s*\(\s*['"]([^'"]+)['"]""",
        re.IGNORECASE
    )
    for f in py_files:
        if "url" in f.name.lower() or "route" in f.name.lower():
            content = read_file_safe(f)
            for m in django_re.finditer(content):
                add_route("ANY", "/" + m.group(1), rel(f), "Django")

    # --- Spring Boot (Java) ---
    java_files = find_files(["*.java", "*.kt"])
    spring_re = re.compile(
        r"""@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]""",
        re.IGNORECASE
    )
    for f in java_files:
        content = read_file_safe(f)
        for m in spring_re.finditer(content):
            mapping = m.group(1).lower()
            method = mapping.replace("mapping", "").upper()
            if method == "REQUEST":
                method = "ANY"
            add_route(method, m.group(2), rel(f), "Spring Boot")

    # --- Go Gin / Echo ---
    go_files = find_files(["*.go"])
    go_re = re.compile(
        r"""\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*['"]([^'"]+)['"]""",
        re.IGNORECASE
    )
    for f in go_files:
        content = read_file_safe(f)
        for m in go_re.finditer(content):
            add_route(m.group(1), m.group(2), rel(f), "Go")

    # --- Next.js API routes (app/api/**/route.ts with exported GET/POST/etc.) ---
    nextjs_api_re = re.compile(
        r"""export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(""",
    )
    for api_dir in ["app/api", "src/app/api", "pages/api", "src/pages/api"]:
        full = REPO_ROOT / api_dir
        if full.is_dir():
            for f in full.rglob("route.ts"):
                if any(part in _EXCLUDE for part in f.relative_to(REPO_ROOT).parts):
                    continue
                content = read_file_safe(f)
                # Derive API path from file path: src/app/api/auth/login/route.ts → /api/auth/login
                try:
                    relative = f.parent.relative_to(full)
                    api_path = "/api/" + str(relative).replace("\\", "/")
                except ValueError:
                    api_path = "/api/" + f.parent.name
                for m in nextjs_api_re.finditer(content):
                    add_route(m.group(1), api_path, rel(f), "Next.js API")
            # Also handle pages/api pattern: pages/api/foo.ts exports default handler
            for f in full.rglob("*.ts"):
                if f.name == "route.ts":
                    continue  # Already handled above
                if any(part in _EXCLUDE for part in f.relative_to(REPO_ROOT).parts):
                    continue
                content = read_file_safe(f)
                if "export default" in content:
                    try:
                        relative = f.relative_to(full)
                        api_path = "/api/" + str(relative).replace("\\", "/")
                        api_path = re.sub(r"\.tsx?$", "", api_path)
                    except ValueError:
                        api_path = "/api/" + f.stem
                    add_route("ANY", api_path, rel(f), "Next.js API")

    return routes


# ---------------------------------------------------------------------------
# 3. Frontend Route Extraction
# ---------------------------------------------------------------------------
def extract_frontend_routes() -> list[dict]:
    """Extract frontend page routes from SPA router configs."""
    routes = []
    seen = set()

    def add_page(path: str, component: str, file: str, framework: str):
        if path not in seen:
            seen.add(path)
            routes.append({"path": path, "component": component, "file": file, "framework": framework})

    js_files = find_files(["*.tsx", "*.jsx", "*.ts", "*.js", "*.vue"])

    # --- React Router ---
    react_re = re.compile(
        r"""<Route\s+[^>]*path\s*=\s*['"`]([^'"`]+)['"`][^>]*element\s*=\s*\{?\s*<(\w+)""",
        re.IGNORECASE
    )
    # Also handle path before or after element
    react_re2 = re.compile(
        r"""<Route\s+[^>]*path\s*=\s*['"`]([^'"`]+)['"`]""",
        re.IGNORECASE
    )
    for f in js_files:
        content = read_file_safe(f)
        for m in react_re.finditer(content):
            add_page(m.group(1), m.group(2), rel(f), "React Router")
        # Fallback: just path without element
        if not routes:
            for m in react_re2.finditer(content):
                add_page(m.group(1), "", rel(f), "React Router")

    # --- Vue Router ---
    vue_re = re.compile(
        r"""path\s*:\s*['"]([^'"]+)['"]\s*,\s*(?:name\s*:[^,]+,\s*)?component\s*:\s*(\w+)""",
        re.IGNORECASE
    )
    for f in js_files:
        content = read_file_safe(f)
        if "createRouter" in content or "VueRouter" in content or "vue-router" in content:
            for m in vue_re.finditer(content):
                add_page(m.group(1), m.group(2), rel(f), "Vue Router")

    # --- Angular Router ---
    angular_re = re.compile(
        r"""path\s*:\s*['"]([^'"]*)['"]\s*,\s*component\s*:\s*(\w+)""",
        re.IGNORECASE
    )
    for f in js_files:
        content = read_file_safe(f)
        if "RouterModule" in content or "@angular/router" in content:
            for m in angular_re.finditer(content):
                path_val = "/" + m.group(1) if not m.group(1).startswith("/") else m.group(1)
                add_page(path_val, m.group(2), rel(f), "Angular")

    # --- Next.js file-based routing ---
    for pages_dir in ["pages", "src/pages", "app", "src/app"]:
        full = REPO_ROOT / pages_dir
        if full.is_dir():
            for f in full.rglob("*"):
                if f.suffix in (".tsx", ".jsx", ".ts", ".js") and f.name != "_app.tsx" and f.name != "_document.tsx":
                    route = "/" + str(f.relative_to(full)).replace("\\", "/")
                    route = re.sub(r"/index\.\w+$", "", route)
                    route = re.sub(r"\.\w+$", "", route)
                    route = re.sub(r"\[([^\]]+)\]", r":\1", route)
                    if "page" in f.name:
                        route = re.sub(r"/page$", "", route)
                    if route:
                        add_page(route or "/", f.stem, rel(f), "Next.js")

    return routes


# ---------------------------------------------------------------------------
# 4. Test Description Extraction
# ---------------------------------------------------------------------------
def extract_test_descriptions() -> list[dict]:
    """Extract test suite/case descriptions from test files."""
    tests = []

    # --- Find test files ---
    test_files = []
    # By filename pattern
    for pattern in ["*.test.ts", "*.test.js", "*.test.tsx", "*.test.jsx",
                     "*.spec.ts", "*.spec.js", "*.spec.tsx", "*.spec.jsx",
                     "test_*.py", "*_test.py", "*_test.go",
                     "*Test.java", "*Test.kt", "*_spec.rb"]:
        test_files.extend(find_files([pattern]))
    # By known folders
    for folder in ["__tests__", "tests", "test", "spec", "src/test"]:
        full = REPO_ROOT / folder
        if full.is_dir():
            for ext in ["*.ts", "*.js", "*.py", "*.java", "*.go", "*.rb"]:
                for f in full.rglob(ext):
                    if f not in test_files:
                        test_files.append(f)

    test_files = sorted(set(test_files))[:MAX_FILES_PER_GLOB]

    # --- JS/TS: describe() / it() / test() ---
    describe_re = re.compile(r"""(?:describe|context)\s*\(\s*['"`](.+?)['"`]""")
    it_re = re.compile(r"""(?:it|test)\s*\(\s*['"`](.+?)['"`]""")

    # --- Python: def test_* / class Test* ---
    py_func_re = re.compile(r"""def\s+(test_\w+)""")
    py_class_re = re.compile(r"""class\s+(Test\w+)""")

    # --- Java: @Test + @DisplayName ---
    java_test_re = re.compile(r"""@DisplayName\s*\(\s*"(.+?)"\s*\)""")
    java_method_re = re.compile(r"""@Test\s+.*?(?:void|public)\s+(\w+)\s*\(""", re.DOTALL)

    # --- Go: func Test* ---
    go_re = re.compile(r"""func\s+(Test\w+)\s*\(""")

    # --- Ruby: describe / it ---
    rb_describe_re = re.compile(r"""(?:describe|context)\s+['"](.+?)['"]""")
    rb_it_re = re.compile(r"""it\s+['"](.+?)['"]""")

    for f in test_files:
        content = read_file_safe(f)
        if not content:
            continue

        file_rel = rel(f)
        suite_items = []

        if f.suffix in (".ts", ".js", ".tsx", ".jsx", ".mjs"):
            current_describe = None
            for line in content.splitlines():
                dm = describe_re.search(line)
                if dm:
                    current_describe = dm.group(1)
                im = it_re.search(line)
                if im:
                    suite_items.append({
                        "suite": current_describe or file_rel,
                        "description": im.group(1),
                    })

        elif f.suffix == ".py":
            current_class = None
            for line in content.splitlines():
                cm = py_class_re.search(line)
                if cm:
                    current_class = cm.group(1)
                fm = py_func_re.search(line)
                if fm:
                    suite_items.append({
                        "suite": current_class or file_rel,
                        "description": fm.group(1).replace("_", " "),
                    })

        elif f.suffix in (".java", ".kt"):
            for m in java_test_re.finditer(content):
                suite_items.append({"suite": f.stem, "description": m.group(1)})
            if not suite_items:
                for m in java_method_re.finditer(content):
                    suite_items.append({"suite": f.stem, "description": m.group(1)})

        elif f.suffix == ".go":
            for m in go_re.finditer(content):
                suite_items.append({"suite": file_rel, "description": m.group(1)})

        elif f.suffix == ".rb":
            current_describe = None
            for line in content.splitlines():
                dm = rb_describe_re.search(line)
                if dm:
                    current_describe = dm.group(1)
                im = rb_it_re.search(line)
                if im:
                    suite_items.append({
                        "suite": current_describe or file_rel,
                        "description": im.group(1),
                    })

        if suite_items:
            tests.append({"file": file_rel, "items": suite_items})

    return tests


# ---------------------------------------------------------------------------
# 5. UI Interaction Extraction
# ---------------------------------------------------------------------------
def extract_ui_interactions() -> list[dict]:
    """Extract button clicks, form submissions, and event handlers."""
    interactions = []
    seen = set()

    ui_files = find_files(["*.tsx", "*.jsx", "*.vue", "*.svelte"])

    # React / generic JSX: onClick={handleFoo} or onClick={() => doFoo()}
    onclick_re = re.compile(r"""on(?:Click|Submit|Change)\s*=\s*\{(?:\s*\(\)\s*=>\s*)?(\w+)""")
    # Button text extraction: >Submit</button> or >Create PR</ or >{loading ? 'x' : 'Create'}<
    button_text_re = re.compile(r""">\s*(?:\{[^}]*?['"`]([^'"`]{2,})['"`][^}]*\}|([A-Z][^<]{1,40}))\s*</""")

    for f in ui_files:
        content = read_file_safe(f)
        file_rel = rel(f)

        handlers = []
        for m in onclick_re.finditer(content):
            handler = m.group(1)
            if handler not in seen:
                seen.add(handler)
                handlers.append(handler)

        if handlers:
            # Try to find nearby button text
            texts = [m.group(1) or m.group(2) for m in button_text_re.finditer(content)]
            interactions.append({
                "file": file_rel,
                "handlers": handlers,
                "button_texts": [t.strip() for t in texts if t and len(t.strip()) > 1][:20],
            })

    return interactions


# ---------------------------------------------------------------------------
# 6. Frontend API Calls Extraction
# ---------------------------------------------------------------------------
def extract_frontend_api_calls() -> list[dict]:
    """Extract HTTP calls from frontend service files."""
    calls = []
    seen = set()

    service_files = find_files(["*.ts", "*.js", "*.tsx"])

    api_re = re.compile(
        r"""(?:apiClient|axios|http|fetch|api)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]""",
        re.IGNORECASE
    )
    fetch_re = re.compile(
        r"""fetch\s*\(\s*[`'"]([^`'"]+)[`'"](?:.*?method\s*:\s*['"](\w+)['"])?""",
        re.IGNORECASE | re.DOTALL
    )

    for f in service_files:
        content = read_file_safe(f)
        file_rel = rel(f)
        file_calls = []

        for m in api_re.finditer(content):
            method = m.group(1).upper()
            path = m.group(2)
            key = f"{method} {path}"
            if key not in seen:
                seen.add(key)
                file_calls.append({"method": method, "path": path})

        for m in fetch_re.finditer(content):
            path = m.group(1)
            method = (m.group(2) or "GET").upper()
            key = f"{method} {path}"
            if key not in seen and path.startswith("/"):
                seen.add(key)
                file_calls.append({"method": method, "path": path})

        if file_calls:
            calls.append({"file": file_rel, "calls": file_calls})

    return calls


# ---------------------------------------------------------------------------
# Output: Write code-inventory.md
# ---------------------------------------------------------------------------
def write_inventory(stack, routes, pages, tests, interactions, api_calls):
    """Write the structured inventory file."""
    lines = []
    lines.append("# Code Inventory (auto-generated)")
    lines.append("")
    lines.append("> This file was generated by `scripts/extract-code-inventory.py`.")
    lines.append("> Codex should read this FIRST before generating user stories.")
    lines.append("")

    # --- Tech Stack ---
    lines.append("## Tech Stack")
    for key, label in [
        ("languages", "Languages"), ("backend_frameworks", "Backend"),
        ("frontend_frameworks", "Frontend"), ("test_frameworks", "Testing"),
        ("databases", "Databases"), ("infrastructure", "Infrastructure"),
    ]:
        items = stack.get(key, [])
        if items:
            lines.append(f"- **{label}:** {', '.join(items)}")
    lines.append("")

    # --- API Endpoints ---
    lines.append(f"## API Endpoints ({len(routes)} found)")
    if routes:
        # Group by file
        by_file = defaultdict(list)
        for r in routes:
            by_file[r["file"]].append(r)
        for file, file_routes in sorted(by_file.items()):
            lines.append(f"### {file}")
            for r in file_routes:
                lines.append(f"- {r['method']:7s} {r['path']}")
            lines.append("")
    else:
        lines.append("_No API endpoints detected._")
        lines.append("")

    # --- Frontend Pages ---
    lines.append(f"## Frontend Pages ({len(pages)} found)")
    if pages:
        for p in pages:
            comp = f" -> {p['component']}" if p['component'] else ""
            lines.append(f"- `{p['path']}`{comp} ({p['file']})")
        lines.append("")
    else:
        lines.append("_No frontend routes detected._")
        lines.append("")

    # --- Test Behaviors ---
    total_tests = sum(len(t["items"]) for t in tests)
    lines.append(f"## Test Behaviors ({total_tests} tests across {len(tests)} files)")
    if tests:
        for t in tests:
            lines.append(f"### {t['file']}")
            suites = defaultdict(list)
            for item in t["items"]:
                suites[item["suite"]].append(item["description"])
            for suite, descriptions in suites.items():
                lines.append(f"**{suite}**")
                for d in descriptions:
                    lines.append(f"- {d}")
            lines.append("")
    else:
        lines.append("_No test files detected._")
        lines.append("")

    # --- UI Interactions ---
    total_handlers = sum(len(i["handlers"]) for i in interactions)
    lines.append(f"## UI Interactions ({total_handlers} handlers found)")
    if interactions:
        for i in interactions:
            lines.append(f"### {i['file']}")
            for h in i["handlers"]:
                lines.append(f"- `{h}()`")
            if i["button_texts"]:
                lines.append(f"  Button labels: {', '.join(repr(t) for t in i['button_texts'][:10])}")
            lines.append("")
    else:
        lines.append("_No UI interactions detected._")
        lines.append("")

    # --- Frontend API Calls ---
    total_calls = sum(len(c["calls"]) for c in api_calls)
    lines.append(f"## Frontend API Calls ({total_calls} found)")
    if api_calls:
        for c in api_calls:
            lines.append(f"### {c['file']}")
            for call in c["calls"]:
                lines.append(f"- {call['method']:7s} {call['path']}")
            lines.append("")
    else:
        lines.append("_No frontend API calls detected._")
        lines.append("")

    OUTPUT_FILE.write_text("\n".join(lines), encoding="utf-8")
    log(f"Wrote {OUTPUT_FILE} ({len(lines)} lines)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    log(f"Scanning repository at {REPO_ROOT}")
    log(f"ast-grep available: {'yes (' + AST_GREP_BIN + ')' if AST_GREP_BIN else 'no (using regex fallback)'}")

    log("Detecting tech stack...")
    stack = detect_tech_stack()
    log(f"  Languages: {stack['languages']}")
    log(f"  Backend: {stack['backend_frameworks']}")
    log(f"  Frontend: {stack['frontend_frameworks']}")
    log(f"  Tests: {stack['test_frameworks']}")

    log("Extracting API routes...")
    routes = extract_api_routes()
    log(f"  Found {len(routes)} routes")

    log("Extracting frontend routes...")
    pages = extract_frontend_routes()
    log(f"  Found {len(pages)} pages")

    log("Extracting test descriptions...")
    tests = extract_test_descriptions()
    total_tests = sum(len(t["items"]) for t in tests)
    log(f"  Found {total_tests} tests across {len(tests)} files")

    log("Extracting UI interactions...")
    interactions = extract_ui_interactions()
    total_handlers = sum(len(i["handlers"]) for i in interactions)
    log(f"  Found {total_handlers} handlers")

    log("Extracting frontend API calls...")
    api_calls = extract_frontend_api_calls()
    total_calls = sum(len(c["calls"]) for c in api_calls)
    log(f"  Found {total_calls} API calls")

    log("Writing code-inventory.md...")
    write_inventory(stack, routes, pages, tests, interactions, api_calls)

    log("Done!")


if __name__ == "__main__":
    main()
