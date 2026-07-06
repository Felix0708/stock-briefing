#!/usr/bin/env python3
"""저장소 Markdown 문서의 로컬 파일 링크가 실제로 존재하는지 검사한다."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
SKIP_PARTS = {".git", ".next", ".venv", "node_modules"}
LINK_PATTERN = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")


def markdown_files() -> list[Path]:
    return sorted(
        path
        for path in ROOT.rglob("*.md")
        if not SKIP_PARTS.intersection(path.relative_to(ROOT).parts)
    )


def local_target(raw_target: str) -> str | None:
    target = raw_target.strip()
    if target.startswith("<") and ">" in target:
        target = target[1 : target.index(">")]
    else:
        target = target.split(maxsplit=1)[0]

    if not target or target.startswith(("#", "http://", "https://", "mailto:")):
        return None
    return unquote(target.split("#", 1)[0])


def main() -> int:
    failures: list[str] = []
    for document in markdown_files():
        content = document.read_text(encoding="utf-8")
        for match in LINK_PATTERN.finditer(content):
            target = local_target(match.group(1))
            if target is None:
                continue
            resolved = (document.parent / target).resolve()
            if not resolved.exists():
                line = content.count("\n", 0, match.start()) + 1
                failures.append(
                    f"{document.relative_to(ROOT)}:{line}: 없는 링크 대상: {target}"
                )

    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1

    print(f"Markdown 로컬 링크 검사 성공 ({len(markdown_files())}개 문서)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
