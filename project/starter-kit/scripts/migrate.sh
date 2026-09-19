#!/usr/bin/env bash
# Wraps the dotnet-ef flags so you stop retyping them.
#   ./scripts/migrate.sh add AddTaskDueDate
#   ./scripts/migrate.sh update
#   ./scripts/migrate.sh script          # idempotent SQL, for review
#   ./scripts/migrate.sh list
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${MIGRATIONS_PROJECT:-src/TaskFlow.Infrastructure}"
STARTUP="${STARTUP_PROJECT:-src/TaskFlow.Api}"
EF=(dotnet ef --project "$PROJECT" --startup-project "$STARTUP")

case "${1:-}" in
  add)
    [[ -n "${2:-}" ]] || { echo "usage: $0 add <MigrationName>" >&2; exit 1; }
    "${EF[@]}" migrations add "$2"
    echo
    echo "Now READ the generated migration before committing it."
    echo "A rename can come out as a drop-and-add, which destroys data."
    ;;
  update)  "${EF[@]}" database update "${2:-}" ;;
  remove)  "${EF[@]}" migrations remove ;;
  list)    "${EF[@]}" migrations list ;;
  script)
    mkdir -p docs/migrations
    "${EF[@]}" migrations script --idempotent -o docs/migrations/migrate.sql
    echo "wrote docs/migrations/migrate.sql"
    ;;
  *) echo "usage: $0 {add <name>|update [target]|remove|list|script}" >&2; exit 1 ;;
esac
