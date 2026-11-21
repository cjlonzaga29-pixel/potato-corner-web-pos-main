#!/usr/bin/env bash
# POS-PERF-P62 — disposable LOCAL stack for browser verification and timing.
# Never points at production, pos_verify or another session's services: every
# URL below is 127.0.0.1/localhost on this task's ports, and the database is a
# fresh embedded Postgres named $P62_DB (default p62_browser) in a short
# task-owned directory ($P62_ROOT, default /c/p62).
#
#   tests/e2e/manual/p62/stack.sh env      # print the env file path (creates it once)
#   tests/e2e/manual/p62/stack.sh pg       # foreground: embedded Postgres (Ctrl-C stops)
#   tests/e2e/manual/p62/stack.sh prepare  # migrate, seed, P62 fixtures
#   tests/e2e/manual/p62/stack.sh build    # API tsc + web next build (production, SW on)
#   tests/e2e/manual/p62/stack.sh api      # foreground: built API
#   tests/e2e/manual/p62/stack.sh web      # foreground: built web (next start)
#
# Ports avoid the reserved 55158-55557 range. Secrets are random per stack and
# live only in $P62_ROOT/env.sh, outside the repository.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
P62_ROOT="${P62_ROOT:-/c/p62}"
PG_PORT="${P62_PG_PORT:-56431}"
API_PORT="${P62_API_PORT:-56432}"
WEB_PORT="${P62_WEB_PORT:-56433}"
PG_DB="${P62_DB:-p62_browser}"
case "$PG_DB" in p62_*) ;; *) echo "Refusing: P62_DB must start with p62_" >&2; exit 1 ;; esac
DB_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${PG_DB}"
ENV_FILE="$P62_ROOT/env.sh"

make_env() {
  mkdir -p "$P62_ROOT"
  [ -f "$ENV_FILE" ] && return
  # Non-secret test keypair and placeholders from .env.example; fresh random keys.
  (cd "$REPO/apps/api" && node -e '
    const fs = require("fs"), d = require("dotenv");
    const e = d.parse(fs.readFileSync("../../.env.example"));
    delete e.NODE_ENV;
    for (const [k, v] of Object.entries(e)) console.log("export " + k + "=" + JSON.stringify(v).replace(/\$/g, "\\$"));
  ') > "$ENV_FILE"
  {
    echo "export ENCRYPTION_KEY='$(openssl rand -base64 32)'"
    echo "export HASH_KEY='$(openssl rand -base64 32)'"
    echo "export JWT_REFRESH_SECRET='$(openssl rand -hex 32)'"
    echo "export STAFF_PIN_HMAC_SECRET='$(openssl rand -hex 32)'"
    echo "export P62_PIN_ANA='$(( RANDOM % 9000 + 1000 ))$(( RANDOM % 90 + 10 ))'"
    echo "export P62_PIN_BEN='$(( RANDOM % 9000 + 1000 ))$(( RANDOM % 90 + 10 ))'"
    echo "export DATABASE_URL='$DB_URL' DIRECT_URL='$DB_URL'"
    echo "export API_PORT='$API_PORT'"
    echo "export NEXT_PUBLIC_API_URL='http://127.0.0.1:$API_PORT'"
    echo "export NEXT_PUBLIC_APP_URL='http://localhost:$WEB_PORT'"
    echo "export NEXT_PUBLIC_SOCKET_URL='http://127.0.0.1:$API_PORT'"
    echo "unset PRODUCTION_DATABASE_URL_DIRECT"
  } >> "$ENV_FILE"
}

guard() {
  case "$DATABASE_URL" in
    postgresql://postgres:postgres@127.0.0.1:"$PG_PORT"/"$PG_DB") ;;
    *) echo "Refusing: DATABASE_URL is not this task's local $PG_DB" >&2; exit 1 ;;
  esac
  [ -z "${PRODUCTION_DATABASE_URL_DIRECT:-}" ] || { echo "Refusing: production URL set" >&2; exit 1; }
}

make_env
# shellcheck disable=SC1090
. "$ENV_FILE"
guard

case "${1:-}" in
  env) echo "$ENV_FILE" ;;
  pg)
    cd "$REPO/apps/api"
    TEST_PG_PORT="$PG_PORT" TEST_PG_DB_NAME="$PG_DB" TEST_PG_DATA_DIR="$P62_ROOT/pg" exec npx tsx scripts/dev-local-postgres.ts
    ;;
  prepare)
    cd "$REPO/apps/api"
    npx prisma migrate deploy
    ALLOW_DATABASE_SEED=true npx tsx prisma/seed.ts > /dev/null
    ALLOW_DATABASE_SEED=true npx tsx scripts/p62-perf-fixtures.ts 2> "$P62_ROOT/fixtures.json"
    echo "fixtures: $P62_ROOT/fixtures.json"
    ;;
  build)
    (cd "$REPO/apps/api" && npx tsc -p tsconfig.json)
    (cd "$REPO/apps/web" && NODE_ENV=production npx next build)
    ;;
  web-build)
    # old: fa31ede's next.config.ts (the API-caching service worker), restored afterwards.
    # new: the current config. Each output is kept under $P62_ROOT/builds/<variant>.
    variant="${2:?old|new}"
    cd "$REPO/apps/web"
    if [ "$variant" = old ]; then
      cp next.config.ts "$P62_ROOT/next.config.keep.ts"
      trap 'cp "$P62_ROOT/next.config.keep.ts" "$REPO/apps/web/next.config.ts"' EXIT
      git -C "$REPO" show fa31ede:apps/web/next.config.ts > next.config.ts
    fi
    NODE_ENV=production npx next build
    rm -rf "$P62_ROOT/builds/$variant" && mkdir -p "$P62_ROOT/builds/$variant/public"
    cp -r .next "$P62_ROOT/builds/$variant/.next"
    cp public/sw.js* public/workbox-*.js* public/swe-worker-*.js* "$P62_ROOT/builds/$variant/public/"
    ;;
  web-use)
    variant="${2:?old|new}"
    cd "$REPO/apps/web"
    rm -rf .next public/sw.js* public/workbox-*.js* public/swe-worker-*.js*
    cp -r "$P62_ROOT/builds/$variant/.next" .next
    cp "$P62_ROOT/builds/$variant/public/"* public/
    ;;
  api)
    cd "$REPO/apps/api"
    NODE_ENV=production exec node dist/server.js
    ;;
  web)
    cd "$REPO/apps/web"
    NODE_ENV=production exec npx next start -p "$WEB_PORT" -H localhost
    ;;
  *) sed -n '2,14p' "$0"; exit 1 ;;
esac
