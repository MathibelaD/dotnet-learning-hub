#!/usr/bin/env bash
# Bring the backing services up and wait until they are actually ready.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "No .env found. Run: cp .env.example .env" >&2; exit 1; }

docker compose up -d "$@"

echo "waiting for services to become healthy…"
for _ in $(seq 1 60); do
  unhealthy=$(docker compose ps --format json \
    | grep -c '"Health":"starting"' || true)
  [[ "$unhealthy" -eq 0 ]] && break
  sleep 1
done

docker compose ps
echo
echo "  postgres  localhost:5432   (user: taskflow, db: taskflow)"
echo "  redis     localhost:6379"
echo "  seq       http://localhost:5341   (docker compose --profile observability up -d)"
