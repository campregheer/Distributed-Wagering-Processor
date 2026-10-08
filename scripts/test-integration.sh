#!/bin/bash
set -euo pipefail
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=jungle_user DB_PASSWORD=jungle_password
export DB_NAME="jungle_schema_test_run_$(date +%s)_$$"
export WORKERS_ENABLED=false
docker compose exec -T postgres psql -U jungle_user -d postgres -c "CREATE DATABASE ${DB_NAME};"
cleanup() {
  docker compose exec -T postgres psql -U jungle_user -d postgres -c "DROP DATABASE ${DB_NAME} WITH (FORCE);"
}
trap cleanup EXIT
bun run build
bun test ./test/schema.integration.ts --timeout 30000
bun test ./test/financial.integration.ts --timeout 30000
bun test ./test/messaging.integration.ts --timeout 30000
bun test ./test/app.e2e-spec.ts --timeout 30000
