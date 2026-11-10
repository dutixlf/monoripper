#!/usr/bin/env python3
"""Check documentation structure and links, not future Monoripper behavior.

Uses Python stdlib only. YAML syntax/schema needs a separate real YAML parser.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPECS = ROOT / "specs"
REQUIRED = (
    "README.md",
    "ROADMAP.md",
    "product/SCOPE_LATEST.yaml",
    "tech-architecture/tech-stack.md",
    "design/application-api.md",
    "design/runtime.md",
    "design/releases.md",
    "state.yaml",
    "release-plan.yaml",
    "execution-status.yaml",
)


def check():
    errors = []
    for relative in REQUIRED:
        if not (SPECS / relative).is_file():
            errors.append(f"missing: specs/{relative}")

    markdown_files = sorted(SPECS.rglob("*.md"))
    for path in markdown_files:
        text = path.read_text(encoding="utf-8")
        name = path.relative_to(ROOT)
        if len(text.splitlines()) > 300:
            errors.append(f"{name}: exceeds 300 lines; split by responsibility")
        if len(re.findall(r"^```", text, re.MULTILINE)) % 2:
            errors.append(f"{name}: unclosed code fence")
        for target in re.findall(r"\]\(([^)]+)\)", text):
            if re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:", target):
                continue
            local = target.split("#", 1)[0]
            if local and not (path.parent / local).is_file():
                errors.append(f"{name}: broken local link: {target}")

    capsule = SPECS / "epics/e01-local-runtime"
    for number in range(1, 5):
        story = f"e01s{number:02}"
        documents = list(capsule.glob(f"{story}-*.md"))
        if len(documents) != 1:
            errors.append(f"{story}: expected one story specification")
            continue
        text = documents[0].read_text(encoding="utf-8")
        sections = re.findall(r"^## (\d+)\.", text, re.MULTILINE)
        if sections != [str(i) for i in range(1, 21)]:
            errors.append(f"{story}: expected numbered sections 1..20")
        if not (capsule / f"{story}-tasks.yaml").is_file():
            errors.append(f"{story}: missing tasks ledger")

    invariants = {
        "tech-architecture/tech-stack.md": ("Desired state", "single writer", "sandbox"),
        "design/application-api.md": ("owns", "checkImports", "defineResource"),
        "design/runtime.md": ("requestId", "deadline", "SetContext", "drain"),
        "design/releases.md": ("sha256", "Git", "rollback", "--wait"),
    }
    for relative, markers in invariants.items():
        path = SPECS / relative
        if path.is_file():
            text = path.read_text(encoding="utf-8")
            for marker in markers:
                if marker.casefold() not in text.casefold():
                    errors.append(f"specs/{relative}: missing design marker {marker!r}")

    for error in errors:
        print(f"FAIL: {error}", file=sys.stderr)
    if errors:
        return 1
    print(f"PASS: {len(markdown_files)} Markdown files, local links, story sections and design markers")
    print("Documentation structure only; this command does not execute runtime tests.")
    return 0


if __name__ == "__main__":
    sys.exit(check())
