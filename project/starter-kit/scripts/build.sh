#!/usr/bin/env bash
# Restore, build, test and publish. Fails on any warning.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-1.0.0}"
mkdir -p artifacts
SKIP_TESTS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=true; shift ;;
    --version)    VERSION="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

step() {
  local name="$1"; shift
  local start=$SECONDS
  printf '\n\033[1m── %s\033[0m\n' "$name"
  "$@"
  printf '   %s took %ss\n' "$name" "$((SECONDS - start))"
}

step restore dotnet restore
step build   dotnet build -c Release --no-restore -p:Version="$VERSION"

if [[ "$SKIP_TESTS" == false ]]; then
  step test dotnet test -c Release --no-build \
    --logger "trx;LogFileName=results.trx" --results-directory ./artifacts
fi

step "vulnerability scan" bash -c '
  dotnet list package --vulnerable --include-transitive 2>&1 | tee artifacts/audit.txt
  ! grep -q "has the following vulnerable packages" artifacts/audit.txt
'

printf '\n\033[32m✓ build complete\033[0m\n'
