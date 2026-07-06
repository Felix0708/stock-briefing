#!/usr/bin/env bash

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
if ! SCAN_RESULT="$(mktemp)"; then
  printf '[FAIL] Secret 검사 임시 파일을 생성하지 못했습니다.\n' >&2
  exit 1
fi
trap 'rm -f "$SCAN_RESULT"' EXIT

pass() {
  printf '[PASS] %s\n' "$1"
}

fail() {
  printf '[FAIL] %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

cd "$ROOT"

if git check-ignore -q .env && git check-ignore -q web/.env.local; then
  pass "루트 .env와 web/.env.local이 Git 추적에서 제외됨"
else
  fail "환경변수 파일 ignore 규칙 누락"
fi

TRACKED_ENV_FILES="$(git ls-files | rg '(^|/)\.env($|\.)' | rg -v '\.example$' || true)"
if [[ -n "$TRACKED_ENV_FILES" ]]; then
  fail "예시 파일이 아닌 환경변수 파일이 Git에 추적됨"
  printf '%s\n' "$TRACKED_ENV_FILES" | sed 's/^/  - /'
else
  pass "Git 추적 파일에 실제 환경변수 파일 없음"
fi

SECRET_PATTERN='(AIza[0-9A-Za-z_-]{30,}|sb_secret_[0-9A-Za-z_-]{20,}|eyJhbGciOiJIUzI1Ni[A-Za-z0-9._-]{40,}|github_pat_[0-9A-Za-z_]{50,}|gh[pousr]_[0-9A-Za-z]{36,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)'
SECRET_FOUND=0
: > "$SCAN_RESULT"
if rg -I -l --hidden \
  -g '!.git/**' -g '!**/node_modules/**' -g '!**/.next/**' \
  -g '!**/.env' -g '!**/.env.*' \
  "$SECRET_PATTERN" "$ROOT" >> "$SCAN_RESULT" 2>/dev/null; then
  SECRET_FOUND=1
fi
if rg -I -l --hidden \
  -g '**/.env.example' -g '**/.env.*.example' \
  "$SECRET_PATTERN" "$ROOT" >> "$SCAN_RESULT" 2>/dev/null; then
  SECRET_FOUND=1
fi
if [[ "$SECRET_FOUND" -eq 1 ]]; then
  fail "작업 트리 소스에서 실제 키 형태 문자열 발견"
  sort -u "$SCAN_RESULT" | sed "s#^$ROOT/##; s/^/  - /"
else
  pass "작업 트리 소스에서 알려진 실제 키 형태 미검출"
fi

BUNDLE_DIR="$ROOT/web/.next/static"
if [[ -d "$BUNDLE_DIR" ]]; then
  if rg -I -l "$SECRET_PATTERN" "$BUNDLE_DIR" > "$SCAN_RESULT" 2>/dev/null; then
    fail "브라우저용 production 번들에서 실제 키 형태 문자열 발견"
    sed "s#^$ROOT/##; s/^/  - /" "$SCAN_RESULT"
  else
    pass "브라우저용 production 번들에서 알려진 실제 키 형태 미검출"
  fi
else
  printf '[SKIP] web/.next/static 없음: production build 후 번들 Secret 검사 필요\n'
fi

git log --all --format='commit %H' --name-only -G "$SECRET_PATTERN" \
  > "$SCAN_RESULT" 2>/dev/null || true
if [[ -s "$SCAN_RESULT" ]]; then
  fail "Git 이력에서 실제 키 형태 문자열이 추가·삭제된 기록 발견"
  sed '/^$/d; s/^/  - /' "$SCAN_RESULT"
else
  pass "Git 이력에서 실제 키 형태 문자열 미검출"
fi

SECRET_ENV_NAMES='(GEMINI_API_KEY|SUPABASE_SECRET_KEY|UPSTASH_REDIS_REST_TOKEN|RATE_LIMIT_IP_HASH_KEY)'
if rg -l "NEXT_PUBLIC_${SECRET_ENV_NAMES}" \
  "$ROOT/web" > "$SCAN_RESULT" 2>/dev/null; then
  fail "Secret이 NEXT_PUBLIC_ 환경변수로 선언됨"
  sed "s#^$ROOT/##; s/^/  - /" "$SCAN_RESULT"
else
  pass "Secret용 NEXT_PUBLIC_ 환경변수 미검출"
fi

CLIENT_SECRET_REF=0
while IFS= read -r -d '' file; do
  if rg -q "^[[:space:]]*['\"]use client['\"]" "$file" && \
    rg -q "$SECRET_ENV_NAMES" "$file"; then
    printf '  - %s\n' "${file#"$ROOT/"}"
    CLIENT_SECRET_REF=1
  fi
done < <(
  find "$ROOT/web" \
    -type d \( -name node_modules -o -name .next \) -prune -o \
    -type f \( -name '*.js' -o -name '*.jsx' -o -name '*.ts' -o -name '*.tsx' \) -print0
)
if [[ "$CLIENT_SECRET_REF" -eq 1 ]]; then
  fail "Client Component에서 Secret 환경변수 참조 발견"
else
  pass "Client Component의 Secret 환경변수 참조 미검출"
fi

printf '\nSecret 점검 결과: 실패 %d건\n' "$FAILURES"
[[ "$FAILURES" -eq 0 ]]
