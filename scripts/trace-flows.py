#!/usr/bin/env python3
"""
trace-flows.py — Flow Tracing for the 8-pass pipeline (Pass 2-3)

Best-effort tracing of end-to-end user flows:
  Page component → event handler → service method → API endpoint → backend handler

Strategy (heuristic, not perfect):
  1. Read each frontend page component
  2. Find onClick/onSubmit handlers
  3. Read the handler function body → find service calls
  4. Match service calls to API client calls in service files
  5. Match API paths to backend handlers (from code-inventory.md or template.yaml)

Output: Appends ## User Flows to code-inventory.md

Runs on: GitHub Actions runner (after extract-code-inventory.py, before Codex)
"""

import os
import re
import sys
from pathlib import Path
from collections import defaultdict

REPO_ROOT = Path(os.environ.get("GITHUB_WORKSPACE", ".")).resolve()
INVENTORY_FILE = REPO_ROOT / "code-inventory.md"

EXCLUDE_DIRS = {
    "node_modules", ".git", "dist", "build", "__pycache__", ".next",
    "coverage", ".nyc_output", "vendor", "target", ".gradle",
    "dist__prebuild_backup", ".verity", ".github"
}

MAX_FILES = 300


def log(msg: str):
    print(f"[trace-flows] {msg}", file=sys.stderr)


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
# Step 1: Find page components and their imports
# ---------------------------------------------------------------------------
def find_page_components() -> list[dict]:
    """Find frontend page components (pages/, views/, app/, or components/ directories)."""
    pages = []
    page_dirs = [
        "pages", "views", "src/pages", "src/views",
        "frontend/src/pages", "frontend/src/views",
        # Next.js app directory
        "app", "src/app",
        # Component directories (may contain page-like components)
        "components", "src/components", "frontend/src/components",
    ]

    for d in page_dirs:
        full = REPO_ROOT / d
        if full.is_dir():
            for ext in ["*.tsx", "*.jsx", "*.vue"]:
                for f in full.rglob(ext):
                    if any(part in EXCLUDE_DIRS for part in f.relative_to(REPO_ROOT).parts):
                        continue
                    # Skip test files, API routes, layouts, and loading files
                    if f.is_file() and "test" not in f.name.lower() \
                            and f.name != "layout.tsx" and f.name != "loading.tsx" \
                            and "api" not in str(f.relative_to(full)).lower().split(os.sep)[:2]:
                        pages.append(f)

    return sorted(set(pages))[:MAX_FILES]


# ---------------------------------------------------------------------------
# Step 2: Extract imports from a component file
# ---------------------------------------------------------------------------
def extract_imports(content: str) -> dict[str, str]:
    """Extract import statements: { imported_name: module_path }."""
    imports = {}

    # import { foo, bar } from './services/api'
    named_re = re.compile(
        r"""import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]"""
    )
    for m in named_re.finditer(content):
        names = [n.strip().split(" as ")[-1].strip() for n in m.group(1).split(",")]
        module = m.group(2)
        for name in names:
            if name:
                imports[name] = module

    # import foo from './services/api'
    default_re = re.compile(
        r"""import\s+(\w+)\s+from\s+['"]([^'"]+)['"]"""
    )
    for m in default_re.finditer(content):
        imports[m.group(1)] = m.group(2)

    return imports


# ---------------------------------------------------------------------------
# Step 3: Find handlers and what they call
# ---------------------------------------------------------------------------
def extract_handler_calls(content: str) -> list[dict]:
    """Find event handlers and the service calls they make."""
    handlers = []

    # Find handler function definitions: const handleFoo = async () => { ... }
    # or function handleFoo() { ... }
    handler_re = re.compile(
        r"""(?:const|let|var|function)\s+(handle\w+|on\w+)\s*=?\s*(?:async\s*)?\(?[^)]*\)?\s*(?:=>)?\s*\{""",
        re.IGNORECASE
    )

    lines = content.splitlines()
    for i, line in enumerate(lines):
        m = handler_re.search(line)
        if not m:
            continue

        handler_name = m.group(1)

        # Read the next ~30 lines to find service calls within this handler
        body = "\n".join(lines[i:i + 40])

        # Find service method calls: someService.someMethod(...) or await someService.someMethod(...)
        service_call_re = re.compile(r"""(?:await\s+)?(\w+Service|\w+service|\w+Api|\w+api)\s*\.\s*(\w+)\s*\(""")
        calls = []
        for sc in service_call_re.finditer(body):
            calls.append({"service": sc.group(1), "method": sc.group(2)})

        # Also find direct API calls: apiClient.post('/foo'), fetch('/foo')
        api_call_re = re.compile(r"""(?:apiClient|axios|http|api)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]""", re.IGNORECASE)
        for ac in api_call_re.finditer(body):
            calls.append({"direct_api": True, "method": ac.group(1).upper(), "path": ac.group(2)})

        # Find bare function calls from hooks: await login(...), await createOrder(...)
        # These are functions destructured from hooks: const { login } = useAuth()
        bare_call_re = re.compile(r"""(?:await\s+)(\w+)\s*\(""")
        skip_names = {"set", "get", "console", "JSON", "Math", "Object", "Array",
                       "parseInt", "parseFloat", "setTimeout", "setInterval",
                       "clearTimeout", "clearInterval", "alert", "confirm",
                       "preventDefault", "stopPropagation", "navigate", "push",
                       "replace", "toString", "trim", "slice", "map", "filter",
                       "reduce", "forEach", "find", "includes", "join", "split",
                       "catch", "then", "finally", handler_name}
        for bc in bare_call_re.finditer(body):
            fn_name = bc.group(1)
            # Skip common built-ins, state setters (setX), and the handler itself
            if fn_name in skip_names:
                continue
            if fn_name.startswith("set") and len(fn_name) > 3 and fn_name[3].isupper():
                continue  # React state setter: setLoading, setError, etc.
            calls.append({"hook_call": True, "function": fn_name})

        if calls:
            handlers.append({
                "name": handler_name,
                "calls": calls,
            })

    return handlers


# ---------------------------------------------------------------------------
# Step 4: Build service → API endpoint map from service files
# ---------------------------------------------------------------------------
def build_service_api_map() -> dict[str, list[dict]]:
    """Map service methods to their API endpoint calls."""
    service_map = defaultdict(list)

    service_dirs = ["services", "src/services", "frontend/src/services",
                    "lib", "src/lib", "frontend/src/lib",
                    "api", "src/api", "frontend/src/api",
                    "utils", "src/utils", "frontend/src/utils"]
    service_files = []
    for d in service_dirs:
        full = REPO_ROOT / d
        if full.is_dir():
            for f in full.rglob("*.ts"):
                if any(part in EXCLUDE_DIRS for part in f.relative_to(REPO_ROOT).parts):
                    continue
                if f.is_file() and "test" not in f.name.lower():
                    service_files.append(f)
            for f in full.rglob("*.js"):
                if any(part in EXCLUDE_DIRS for part in f.relative_to(REPO_ROOT).parts):
                    continue
                if f.is_file() and "test" not in f.name.lower():
                    service_files.append(f)

    api_re = re.compile(
        r"""(?:apiClient|axios|http|api|this\.http)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]""",
        re.IGNORECASE
    )

    for f in service_files:
        content = read_safe(f)
        if not content:
            continue

        file_rel = rel(f)

        # Find all methods and their API calls
        # Look for: async methodName(...) { ... apiClient.post('/path') }
        method_re = re.compile(
            r"""(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w[^{]*)?\{""",
        )

        lines = content.splitlines()
        for i, line in enumerate(lines):
            mm = method_re.search(line)
            if not mm:
                continue

            method_name = mm.group(1)
            # Skip constructors, common non-API methods
            if method_name in ("constructor", "if", "for", "while", "switch", "catch", "return"):
                continue

            # Read body (next ~30 lines)
            body = "\n".join(lines[i:i + 35])

            for ac in api_re.finditer(body):
                http_method = ac.group(1).upper()
                api_path = ac.group(2)
                service_map[method_name].append({
                    "http_method": http_method,
                    "api_path": api_path,
                    "service_file": file_rel,
                })

    return dict(service_map)


# ---------------------------------------------------------------------------
# Step 4b: Build hook function → API endpoint map
# ---------------------------------------------------------------------------
def build_hook_api_map() -> dict[str, list[dict]]:
    """Map functions exported from hooks to their API calls.

    Handles patterns like:
      export function useAuth() {
        const login = async (email, pass) => {
          await axios.post('/api/auth/login', ...);
        }
        return { login, logout };
      }

    Result: { 'login': [{ http_method: 'POST', api_path: '/api/auth/login', ... }] }
    """
    hook_map = defaultdict(list)

    hook_dirs = [
        "hooks", "src/hooks", "frontend/src/hooks",
        "lib", "src/lib", "frontend/src/lib",
        "composables", "src/composables",  # Vue convention
        "services", "src/services", "frontend/src/services",
        "store", "src/store", "frontend/src/store",
        "providers", "src/providers",
    ]

    hook_files = []
    for d in hook_dirs:
        full = REPO_ROOT / d
        if full.is_dir():
            for ext in ["*.ts", "*.tsx", "*.js", "*.jsx"]:
                for f in full.rglob(ext):
                    if any(part in EXCLUDE_DIRS for part in f.relative_to(REPO_ROOT).parts):
                        continue
                    if f.is_file() and "test" not in f.name.lower():
                        hook_files.append(f)

    api_re = re.compile(
        r"""(?:apiClient|axios|http|api|fetch)\s*\.?\s*(?:post|get|put|patch|delete)?\s*\(\s*[`'"]([^`'"]+)[`'"]""",
        re.IGNORECASE
    )
    # More specific patterns
    method_api_re = re.compile(
        r"""(?:apiClient|axios|http|api)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]""",
        re.IGNORECASE
    )
    fetch_re = re.compile(
        r"""fetch\s*\(\s*[`'"]([^`'"]+)[`'"]""",
        re.IGNORECASE
    )

    for f in sorted(set(hook_files))[:MAX_FILES]:
        content = read_safe(f)
        if not content:
            continue

        file_rel = rel(f)
        lines = content.splitlines()

        # Find function/const definitions and their API calls
        func_re = re.compile(
            r"""(?:const|let|var|function|async\s+function)\s+(\w+)\s*=?\s*(?:async\s*)?\(?""",
        )

        for i, line in enumerate(lines):
            fm = func_re.search(line)
            if not fm:
                continue

            fn_name = fm.group(1)
            # Skip common non-API functions
            if fn_name in ("useEffect", "useState", "useCallback", "useMemo", "useRef",
                           "if", "for", "while", "switch", "catch", "constructor"):
                continue

            body = "\n".join(lines[i:i + 40])

            for ac in method_api_re.finditer(body):
                http_method = ac.group(1).upper()
                api_path = ac.group(2)
                hook_map[fn_name].append({
                    "http_method": http_method,
                    "api_path": api_path,
                    "source_file": file_rel,
                })

            for fc in fetch_re.finditer(body):
                api_path = fc.group(1)
                if api_path.startswith("/") or api_path.startswith("$"):
                    hook_map[fn_name].append({
                        "http_method": "ANY",
                        "api_path": api_path,
                        "source_file": file_rel,
                    })

    return dict(hook_map)


# ---------------------------------------------------------------------------
# Step 5: Match API paths to backend handlers
# ---------------------------------------------------------------------------
def build_api_backend_map() -> dict[str, str]:
    """Build map from API path → backend handler file using code-inventory.md."""
    api_map = {}

    if not INVENTORY_FILE.exists():
        return api_map

    content = INVENTORY_FILE.read_text(encoding="utf-8")
    in_section = False
    current_file = None

    for line in content.splitlines():
        if line.startswith("## API Endpoints"):
            in_section = True
            continue
        if line.startswith("## ") and in_section:
            break
        if not in_section:
            continue

        if line.startswith("### "):
            current_file = line[4:].strip()
            continue

        route_match = re.match(r"-\s+(GET|POST|PUT|PATCH|DELETE|ANY)\s+(\S+)", line.strip())
        if route_match and current_file:
            path = route_match.group(2)
            api_map[path] = current_file

    return api_map


# ---------------------------------------------------------------------------
# Step 6: Assemble flows
# ---------------------------------------------------------------------------
def assemble_flows(
    page_components: list[Path],
    service_api_map: dict,
    api_backend_map: dict,
    hook_api_map: dict | None = None,
) -> list[dict]:
    """Assemble end-to-end flows from page → handler → service → API → backend."""
    flows = []
    seen_flows = set()

    for page_path in page_components:
        content = read_safe(page_path)
        if not content:
            continue

        page_rel = rel(page_path)
        page_name = page_path.stem

        imports = extract_imports(content)
        handlers = extract_handler_calls(content)

        for handler in handlers:
            for call in handler["calls"]:
                flow = {
                    "page": page_name,
                    "page_file": page_rel,
                    "handler": handler["name"],
                    "steps": [],
                }

                if call.get("direct_api"):
                    # Handler calls API directly
                    api_path = call["path"]
                    flow["steps"].append(f"{page_name}.{handler['name']}()")
                    flow["steps"].append(f"{call['method']} {api_path}")
                    backend = api_backend_map.get(api_path)
                    if backend:
                        flow["steps"].append(backend)

                elif call.get("hook_call"):
                    # Handler calls a function from a hook: login(), createOrder()
                    fn_name = call["function"]
                    flow["steps"].append(f"{page_name}.{handler['name']}()")
                    flow["steps"].append(f"{fn_name}()")

                    # Look up in hook API map first, then service API map
                    api_calls = (hook_api_map or {}).get(fn_name, []) or service_api_map.get(fn_name, [])
                    if api_calls:
                        for ac in api_calls[:1]:
                            flow["steps"].append(f"{ac['http_method']} {ac['api_path']}")
                            backend = api_backend_map.get(ac["api_path"])
                            if backend:
                                flow["steps"].append(backend)

                else:
                    # Handler calls a service method: authService.login()
                    service_name = call["service"]
                    method_name = call["method"]

                    flow["steps"].append(f"{page_name}.{handler['name']}()")
                    flow["steps"].append(f"{service_name}.{method_name}()")

                    # Look up what API the service method calls
                    api_calls = service_api_map.get(method_name, [])
                    if api_calls:
                        for ac in api_calls[:1]:  # Take first match
                            flow["steps"].append(f"{ac['http_method']} {ac['api_path']}")
                            # Look up backend handler
                            backend = api_backend_map.get(ac["api_path"])
                            if backend:
                                flow["steps"].append(backend)

                # Only keep flows with at least 3 steps (page → service → API)
                flow_key = " → ".join(flow["steps"])
                if len(flow["steps"]) >= 3 and flow_key not in seen_flows:
                    seen_flows.add(flow_key)
                    flow["chain"] = flow_key
                    flows.append(flow)

    return flows


# ---------------------------------------------------------------------------
# Step 7: Find button text near handlers
# ---------------------------------------------------------------------------
def find_button_text_for_handler(content: str, handler_name: str) -> str | None:
    """Try to find button label text near an onClick={handlerName} reference."""
    # Search for: onClick={handlerName} and nearby text
    pattern = re.compile(
        rf"""onClick\s*=\s*\{{\s*{re.escape(handler_name)}\s*\}}[^<]*>([^<]+)<""",
        re.DOTALL
    )
    m = pattern.search(content)
    if m:
        text = m.group(1).strip()
        if text and len(text) > 1 and len(text) < 50:
            return text

    # Try: >{text}</button> near the handler
    # Look for the handler reference and nearby button text
    lines = content.splitlines()
    for i, line in enumerate(lines):
        if handler_name in line and "onClick" in line:
            # Check surrounding 5 lines for button text
            context = "\n".join(lines[max(0, i - 2):i + 5])
            text_re = re.compile(r""">\s*(?:\{[^}]*?['"`]([^'"`]{2,30})['"`]|([A-Z][^<]{1,30}))\s*</""")
            tm = text_re.search(context)
            if tm:
                return (tm.group(1) or tm.group(2) or "").strip() or None

    return None


# ---------------------------------------------------------------------------
# Append to code-inventory.md
# ---------------------------------------------------------------------------
def append_to_inventory(flows: list[dict], page_components: list[Path]):
    """Append User Flows section to code-inventory.md."""
    if not INVENTORY_FILE.exists():
        log(f"WARNING: {INVENTORY_FILE} not found")
        return

    lines = [
        "",
        f"## User Flows ({len(flows)} end-to-end flows traced)",
        "",
    ]

    if not flows:
        lines.append("_No end-to-end flows could be traced._")
    else:
        # Group by page
        by_page = defaultdict(list)
        for f in flows:
            by_page[f["page"]].append(f)

        for page_name, page_flows in sorted(by_page.items()):
            lines.append(f"### {page_name}")
            for f in page_flows:
                # Try to find a readable label
                label = f["handler"]
                lines.append(f"- **{label}**: {f['chain']}")
            lines.append("")

    existing = INVENTORY_FILE.read_text(encoding="utf-8")
    INVENTORY_FILE.write_text(existing + "\n".join(lines), encoding="utf-8")
    log(f"Appended {len(flows)} flows to {INVENTORY_FILE}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    log(f"Scanning repository at {REPO_ROOT}")

    log("Finding page components...")
    pages = find_page_components()
    log(f"  Found {len(pages)} page components")

    if not pages:
        log("No page components found. Skipping flow tracing.")
        append_to_inventory([], [])
        return

    log("Building service → API endpoint map...")
    service_api_map = build_service_api_map()
    log(f"  Mapped {len(service_api_map)} service methods to API calls")

    log("Building hook → API endpoint map...")
    hook_api_map = build_hook_api_map()
    log(f"  Mapped {len(hook_api_map)} hook functions to API calls")

    log("Building API path → backend handler map...")
    api_backend_map = build_api_backend_map()
    log(f"  Mapped {len(api_backend_map)} API paths to backend files")

    log("Assembling end-to-end flows...")
    flows = assemble_flows(pages, service_api_map, api_backend_map, hook_api_map)
    log(f"  Traced {len(flows)} flows")

    if flows:
        log("  Sample flows:")
        for f in flows[:5]:
            log(f"    {f['chain']}")

    log("Appending to code-inventory.md...")
    append_to_inventory(flows, pages)

    log("Done!")


if __name__ == "__main__":
    main()
