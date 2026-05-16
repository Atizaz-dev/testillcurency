#!/usr/bin/env python3
"""Detect repository project structure for routing decisions.

This script analyzes the repository to determine:
- Project type: MONO, FRONTEND, BACKEND, or SHARED
- Stack: What frameworks are used (react, vue, express, etc.)
- Paths: Where frontend/backend/shared code lives

Output is JSON that can be:
1. Stored in .verity/config.yml (project section)
2. Sent to Verity backend via webhook
3. Used by sync_repo_docs.py to generate REPO_CONTEXT.md

Usage:
    python scripts/detect_repo_structure.py | jq .
    python scripts/detect_repo_structure.py > structure.json
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

# Markers that indicate frontend code
FRONTEND_MARKERS = {
    'dirs': ['frontend', 'client', 'web', 'app', 'ui'],
    'files': ['next.config.js', 'next.config.mjs', 'vite.config.ts', 'vite.config.js',
              'angular.json', 'vue.config.js', 'nuxt.config.ts', 'nuxt.config.js',
              'svelte.config.js', 'remix.config.js', 'astro.config.mjs'],
    'package_deps': ['react', 'vue', 'angular', 'svelte', '@angular/core', 'next', 
                     'nuxt', 'gatsby', 'remix', 'astro', 'solid-js', 'preact']
}

# Markers that indicate backend code
BACKEND_MARKERS = {
    'dirs': ['backend', 'server', 'api', 'services', 'handlers', 'functions', 'lambdas'],
    'files': ['template.yaml', 'template.yml', 'serverless.yml', 'serverless.yaml',
              'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
              'manage.py', 'app.py', 'main.py', 'index.ts', 'server.ts'],
    'package_deps': ['express', 'fastify', 'koa', 'hapi', 'nest', '@nestjs/core',
                     'aws-lambda', '@aws-sdk/client-lambda']
}


@dataclass
class StructureInfo:
    type: str = 'UNKNOWN'
    stack: dict[str, str | None] = field(default_factory=dict)
    paths: dict[str, list[str]] = field(default_factory=dict)
    confidence: float = 0.0
    detected_at: int = 0


def safe_load_json(path: Path) -> dict | None:
    """Safely load a JSON file, returning None on any error."""
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as e:
        print(f"Warning: Could not parse {path}: {e}", file=__import__('sys').stderr)
        return None


def get_top_level_dirs(root: Path = Path('.')) -> list[str]:
    """Get list of top-level directory names."""
    ignore = {'.git', '.github', '.verity', '.venv', '__pycache__', 
              'node_modules', 'dist', 'build', '.next', '.nuxt', 'coverage'}
    dirs = []
    for entry in root.iterdir():
        if entry.is_dir() and entry.name not in ignore and not entry.name.startswith('.'):
            dirs.append(entry.name)
    return sorted(dirs)


def get_top_level_files(root: Path = Path('.')) -> list[str]:
    """Get list of top-level file names."""
    files = []
    for entry in root.iterdir():
        if entry.is_file() and not entry.name.startswith('.'):
            files.append(entry.name)
    return sorted(files)


def detect_frontend_stack(root: Path = Path('.')) -> str | None:
    """Detect the frontend framework being used."""
    # Check package.json at root
    pkg = safe_load_json(root / 'package.json')
    if pkg:
        deps = {**pkg.get('dependencies', {}), **pkg.get('devDependencies', {})}
        if 'next' in deps:
            return 'next'
        if 'nuxt' in deps:
            return 'nuxt'
        if '@angular/core' in deps:
            return 'angular'
        if 'vue' in deps:
            return 'vue'
        if 'svelte' in deps:
            return 'svelte'
        if 'react' in deps:
            return 'react'
        if 'solid-js' in deps:
            return 'solid'
        if 'preact' in deps:
            return 'preact'
        if 'astro' in deps:
            return 'astro'
    
    # Check frontend/ subdirectory
    frontend_pkg = safe_load_json(root / 'frontend' / 'package.json')
    if frontend_pkg:
        deps = {**frontend_pkg.get('dependencies', {}), **frontend_pkg.get('devDependencies', {})}
        if 'next' in deps:
            return 'next'
        if 'react' in deps:
            return 'react'
        if 'vue' in deps:
            return 'vue'
    
    return None


def detect_backend_stack(root: Path = Path('.')) -> str | None:
    """Detect the backend framework being used."""
    # Check for SAM/Serverless
    if (root / 'template.yaml').exists() or (root / 'template.yml').exists():
        return 'sam'
    if (root / 'serverless.yml').exists() or (root / 'serverless.yaml').exists():
        return 'serverless'
    if (root / 'cdk.json').exists():
        return 'cdk'
    
    # Check package.json for Node backend
    pkg = safe_load_json(root / 'package.json')
    if pkg:
        deps = {**pkg.get('dependencies', {}), **pkg.get('devDependencies', {})}
        if '@nestjs/core' in deps:
            return 'nest'
        if 'express' in deps:
            return 'express'
        if 'fastify' in deps:
            return 'fastify'
        if 'koa' in deps:
            return 'koa'
    
    # Check backend/ subdirectory
    backend_pkg = safe_load_json(root / 'backend' / 'package.json')
    if backend_pkg:
        deps = {**backend_pkg.get('dependencies', {}), **backend_pkg.get('devDependencies', {})}
        if '@nestjs/core' in deps:
            return 'nest'
        if 'express' in deps:
            return 'express'
        if 'fastify' in deps:
            return 'fastify'
    
    # Check for Python backend
    reqs_path = root / 'requirements.txt'
    if reqs_path.exists():
        try:
            reqs = reqs_path.read_text(encoding='utf-8').lower()
        except (UnicodeDecodeError, OSError):
            reqs = ''
        if 'fastapi' in reqs:
            return 'fastapi'
        if 'django' in reqs:
            return 'django'
        if 'flask' in reqs:
            return 'flask'
    
    backend_reqs = root / 'backend' / 'requirements.txt'
    if backend_reqs.exists():
        try:
            reqs = backend_reqs.read_text(encoding='utf-8').lower()
        except (UnicodeDecodeError, OSError):
            reqs = ''
        if 'fastapi' in reqs:
            return 'fastapi'
        if 'django' in reqs:
            return 'django'
        if 'flask' in reqs:
            return 'flask'
    
    return None


def detect_frontend_paths(root: Path = Path('.')) -> list[str]:
    """Find directories containing frontend code."""
    paths = []
    dirs = get_top_level_dirs(root)
    
    # Check for explicit frontend directories (exact match)
    for marker in FRONTEND_MARKERS['dirs']:
        if marker in dirs:
            paths.append(marker)
    
    # Check for frontend markers in root
    files = get_top_level_files(root)
    for marker_file in FRONTEND_MARKERS['files']:
        if marker_file in files:
            # Root has frontend config, add src/ if exists
            if 'src' in dirs and 'src' not in paths:
                paths.append('src')
            break
    
    # Check package.json deps
    pkg = safe_load_json(root / 'package.json')
    if pkg:
        deps = set(pkg.get('dependencies', {}).keys()) | set(pkg.get('devDependencies', {}).keys())
        if deps & set(FRONTEND_MARKERS['package_deps']):
            # Root has frontend deps
            if 'src' in dirs and 'src' not in paths:
                paths.append('src')
            if 'pages' in dirs and 'pages' not in paths:
                paths.append('pages')
            if 'components' in dirs and 'components' not in paths:
                paths.append('components')
    
    return sorted(set(paths))


def detect_backend_paths(root: Path = Path('.')) -> list[str]:
    """Find directories containing backend code."""
    paths = []
    dirs = get_top_level_dirs(root)
    
    # Check for explicit backend directories (exact match)
    for marker in BACKEND_MARKERS['dirs']:
        if marker in dirs:
            paths.append(marker)
    
    # Check for backend markers in root
    files = get_top_level_files(root)
    for marker_file in BACKEND_MARKERS['files']:
        if marker_file in files:
            # Root has backend config
            if 'src' in dirs and 'src' not in paths:
                paths.append('src')
            break
    
    return sorted(set(paths))


def detect_shared_paths(root: Path = Path('.')) -> list[str]:
    """Find shared/common code directories."""
    dirs = get_top_level_dirs(root)
    shared_patterns = ['lib', 'packages', 'shared', 'common', 'utils', 'scripts']
    return sorted([p for p in shared_patterns if p in dirs])


def detect_project_type(root: Path = Path('.')) -> dict[str, Any]:
    """
    Main detection function.
    
    Returns a dict with:
    - type: MONO, FRONTEND, BACKEND, or SHARED
    - stack: {frontend: 'react', backend: 'express'}
    - paths: {frontend: ['frontend/src'], backend: ['backend/'], shared: ['lib/']}
    - confidence: 0.0-1.0
    """
    import time
    
    frontend_paths = detect_frontend_paths(root)
    backend_paths = detect_backend_paths(root)
    shared_paths = detect_shared_paths(root)
    
    frontend_stack = detect_frontend_stack(root)
    backend_stack = detect_backend_stack(root)
    
    has_frontend = len(frontend_paths) > 0 or frontend_stack is not None
    has_backend = len(backend_paths) > 0 or backend_stack is not None
    
    # Determine project type
    if has_frontend and has_backend:
        project_type = 'MONO'
        confidence = 0.9
    elif has_frontend and not has_backend:
        project_type = 'FRONTEND'
        confidence = 0.85
    elif has_backend and not has_frontend:
        project_type = 'BACKEND'
        confidence = 0.85
    else:
        project_type = 'SHARED'
        confidence = 0.5
    
    # Build paths dict
    paths: dict[str, list[str]] = {}
    if frontend_paths:
        paths['frontend'] = frontend_paths
    if backend_paths:
        paths['backend'] = backend_paths
    if shared_paths:
        paths['shared'] = shared_paths
    
    # Build stack dict
    stack: dict[str, str | None] = {}
    if frontend_stack:
        stack['frontend'] = frontend_stack
    if backend_stack:
        stack['backend'] = backend_stack
    
    return {
        'type': project_type,
        'stack': stack,
        'paths': paths,
        'confidence': confidence,
        'detectedAt': int(time.time() * 1000)  # Unix timestamp in ms
    }


# FIX #24: Add __main__ block so script can be run directly from CLI
# Usage: python scripts/detect_repo_structure.py | jq .
if __name__ == '__main__':
    result = detect_project_type()
    print(json.dumps(result, indent=2))
