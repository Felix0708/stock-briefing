#!/usr/bin/env bash

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT/web"
PYTHON_BIN="${PYTHON_BIN:-python3}"
if [[ -x "$ROOT/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT/.venv/bin/python"
fi
if ! PYTHON_CACHE_DIR="$(mktemp -d)"; then
  printf '[FAIL] QA용 Python 임시 캐시 디렉터리를 생성하지 못했습니다.\n' >&2
  exit 1
fi
trap 'rm -rf "$PYTHON_CACHE_DIR"' EXIT
RUN_BUILD=0
BASE_URL=""
FAILURES=0
WARNINGS=0

usage() {
  cat <<'EOF'
Usage: scripts/qa.sh [--build] [--base-url URL]

  --build         Next.js production build와 브라우저 번들 Secret 검사를 실행
  --base-url URL  실행 중인 웹앱의 /api/ask 스모크 테스트를 실행
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      RUN_BUILD=1
      shift
      ;;
    --base-url)
      if [[ $# -lt 2 ]]; then
        printf '[FAIL] --base-url 뒤에 URL이 필요합니다.\n' >&2
        exit 2
      fi
      BASE_URL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '[FAIL] 알 수 없는 옵션: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

pass() {
  printf '[PASS] %s\n' "$1"
}

fail() {
  printf '[FAIL] %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

warn() {
  printf '[WARN] %s\n' "$1"
  WARNINGS=$((WARNINGS + 1))
}

section() {
  printf '\n## %s\n' "$1"
}

cd "$ROOT"

section "Secret 정적 점검"
if "$ROOT/scripts/check-secrets.sh"; then
  pass "Secret 정적 점검 성공"
else
  fail "Secret 정적 점검 실패"
fi

section "Python 파이프라인 점검"
if PYTHONPYCACHEPREFIX="$PYTHON_CACHE_DIR" "$PYTHON_BIN" -m compileall -q pipeline; then
  pass "Python 모듈 구문 검사 성공"
else
  fail "Python 모듈 구문 검사 실패"
fi

section "저장소 구조·문서 점검"
if git diff --check; then
  pass "Git 공백 오류 없음"
else
  fail "Git 공백 오류 발견"
fi

if "$PYTHON_BIN" "$ROOT/scripts/check-markdown-links.py"; then
  pass "Markdown 로컬 링크 검사 성공"
else
  fail "Markdown 로컬 링크 검사 실패"
fi

if rg -n \
  --glob '*.md' --glob '*.sh' --glob '*.yml' --glob '*.yaml' --glob '!scripts/qa.sh' \
  'web/(app|components|lib)/|scripts/phase2-2-qa\.sh|docs/PHASE2_2_' \
  "$ROOT" > /tmp/stock-briefing-stale-paths.txt 2>/dev/null; then
  fail "이동 전 경로 참조 발견: /tmp/stock-briefing-stale-paths.txt 확인"
else
  pass "이동 전 경로 참조 없음"
fi

section "웹앱 구조·정적 점검"
if [[ -f "$WEB_DIR/package.json" ]]; then
  pass "web/package.json 존재"
else
  fail "web/package.json 없음"
fi

if [[ -f "$WEB_DIR/src/app/api/ask/route.ts" ]]; then
  pass "질문 API Route 존재"
else
  fail "web/src/app/api/ask/route.ts 없음"
fi

if [[ -f "$WEB_DIR/tests/api-route.test.mjs" ]] && \
  (cd "$WEB_DIR" && npm run test:api); then
  pass "API Route 모킹 회귀 테스트 성공"
else
  fail "API Route 모킹 회귀 테스트 실패"
fi

if [[ -x "$WEB_DIR/node_modules/.bin/eslint" ]] && \
  [[ -x "$WEB_DIR/node_modules/.bin/tsc" ]]; then
  if (cd "$WEB_DIR" && npm run lint); then
    pass "ESLint 성공"
  else
    fail "ESLint 실패"
  fi

  if (cd "$WEB_DIR" && npm run typecheck); then
    pass "TypeScript 타입 검사 성공"
  else
    fail "TypeScript 타입 검사 실패"
  fi
else
  warn "개발 의존성 미설치: cd web && npm install 실행 필요"
fi

if [[ "$RUN_BUILD" -eq 1 ]]; then
  if [[ -x "$WEB_DIR/node_modules/.bin/next" ]] && \
    (cd "$WEB_DIR" && npm run build); then
    pass "Next.js production build 성공"
    if [[ -d "$WEB_DIR/.next/static" ]] && \
      rg -I -l \
        '(AIza[0-9A-Za-z_-]{30,}|sb_secret_[0-9A-Za-z_-]{20,}|eyJhbGciOiJIUzI1Ni[A-Za-z0-9._-]{40,})' \
        "$WEB_DIR/.next/static" > /tmp/stock-briefing-bundle-secret-scan.txt 2>/dev/null; then
      fail "브라우저용 production 번들에서 실제 키 형태 문자열 발견"
    else
      pass "브라우저용 production 번들에서 실제 키 형태 미검출"
    fi
  else
    fail "Next.js production build 실패 또는 의존성 미설치"
  fi
else
  warn "빌드 미실행: 전체 검증은 scripts/qa.sh --build 사용"
fi

section "로컬 API 스모크 점검"
if [[ -n "$BASE_URL" ]]; then
  BASE_URL="${BASE_URL%/}"
  TMP_BODY="$(mktemp)"

  STATUS="$(curl -sS -o "$TMP_BODY" -w '%{http_code}' \
    -H 'Content-Type: application/json' -d '{}' "$BASE_URL/api/ask" || true)"
  if [[ "$STATUS" == "400" ]]; then
    pass "빈 질문 요청을 400으로 거부"
  else
    fail "빈 질문 응답 코드가 400이 아님 (실제: ${STATUS:-요청 실패})"
  fi

  STATUS="$(curl -sS -o "$TMP_BODY" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -d '{"question":"최근 공시의 핵심 내용을 알려줘"}' "$BASE_URL/api/ask" || true)"
  if [[ "$STATUS" == "200" ]] && \
    node -e '
      const fs = require("fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (typeof value.answer !== "string" || !value.answer.trim()) process.exit(1);
      if (!Array.isArray(value.sources) || value.sources.length === 0) process.exit(1);
      if (!value.sources.every((source) => /^https:\/\/(dart\.fss\.or\.kr|opendart\.fss\.or\.kr)\//.test(source.url))) process.exit(1);
    ' "$TMP_BODY"; then
    pass "정상 질문 응답에 answer와 DART 출처 링크 포함"
  else
    fail "정상 질문 응답 형식/출처 링크 검증 실패 (HTTP ${STATUS:-요청 실패})"
  fi

  rm -f "$TMP_BODY"
else
  warn "API 미실행: scripts/qa.sh --base-url http://localhost:3000 사용"
fi

printf '\nQA 결과: 실패 %d건, 경고 %d건\n' "$FAILURES" "$WARNINGS"
[[ "$FAILURES" -eq 0 ]]
