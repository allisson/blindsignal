#!/usr/bin/env bash
# Runs the production image as a deployment would (ADR 0033): migrations, then the server with a
# read-only filesystem and no capabilities, against PostgreSQL, then a stop within the grace period.
# Usage: .github/scripts/image-smoke.sh <image>
set -euo pipefail

image=${1:?usage: image-smoke.sh <image>}
name=blindsignal-smoke-$$
dir=$(mktemp -d)
database_url=postgres://blindsignal:smoke-password@$name-postgres:5432/blindsignal

cleanup() {
  docker rm -f "$name-server" "$name-postgres" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  rm -rf "$dir"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  docker logs "$name-server" 2>&1 | tail -20 >&2 || true
  exit 1
}

[ "$(docker image inspect -f '{{.Config.User}}' "$image")" = node ] || fail 'image does not run as node'
docker run --rm --entrypoint sh "$image" -c '! command -v npm' >/dev/null || fail 'npm is in the image'
[ -z "$(docker run --rm --entrypoint find "$image" /app -path /app/node_modules -prune -o \
  '(' -name '*.test.ts' -o -name testing ')' -print)" ] || fail 'tests are in the image'

docker network create "$name" >/dev/null
docker run -d --name "$name-postgres" --network "$name" \
  -e POSTGRES_USER=blindsignal -e POSTGRES_PASSWORD=smoke-password -e POSTGRES_DB=blindsignal \
  --health-cmd 'pg_isready -U blindsignal -d blindsignal' --health-interval 1s \
  postgres:18.6-alpine >/dev/null
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$name-postgres")" = healthy ]; do sleep 1; done

docker run --rm --network "$name" -e BLINDSIGNAL_DATABASE_URL="$database_url" "$image" \
  node adapters/storage/postgresql/src/migrate-command.ts | grep -q applied || fail 'migrations did not apply'

# A production registry with a fresh public key; no token is issued in this test.
docker run --rm --entrypoint node "$image" -e '
  const { publicKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const key = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "smoke" };
  delete key.key_ops; delete key.ext;
  console.log(JSON.stringify({ applications: [{ appId: "smoke", name: "smoke", status: "active",
    issuer: "https://issuer.example.com", audience: "blindsignal", publicKeys: [key], algorithms: ["ES256"] }] }));
' --input-type=module >"$dir/registry.json"
chmod 644 "$dir/registry.json"

docker run -d --name "$name-server" --network "$name" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$dir/registry.json:/etc/blindsignal/registry.json:ro" \
  -e BLINDSIGNAL_REGISTRY_PATH=/etc/blindsignal/registry.json \
  -e BLINDSIGNAL_ALLOWED_ORIGINS=https://app.example.com \
  -e BLINDSIGNAL_DATABASE_URL="$database_url" \
  -e BLINDSIGNAL_ADMIN_HOST=0.0.0.0 \
  -p 127.0.0.1::8080 -p 127.0.0.1::9090 \
  "$image" >/dev/null

for _ in $(seq 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$name-server")
  [ "$status" = healthy ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$name-server")" = true ] || fail 'server exited'
  sleep 1
done
[ "$status" = healthy ] || fail "health check is $status"

port=$(docker port "$name-server" 8080 | head -1 | cut -d: -f2)
admin_port=$(docker port "$name-server" 9090 | head -1 | cut -d: -f2)
curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null || fail 'readiness failed'
curl -fsS "http://127.0.0.1:$admin_port/metrics" | grep -q '^blindsignal_dependency_up{dependency="postgresql"} 1' ||
  fail 'PostgreSQL is not reported up'

started=$(date +%s)
docker stop -t 10 "$name-server" >/dev/null
elapsed=$(($(date +%s) - started))
code=$(docker inspect -f '{{.State.ExitCode}}' "$name-server")
[ "$code" = 0 ] || fail "server exited with $code"
[ "$elapsed" -lt 10 ] || fail "stop took ${elapsed}s"
docker logs "$name-server" 2>&1 | grep -q '"server.draining"' || fail 'no server.draining log'

echo "ok: $image migrated, served, and stopped in ${elapsed}s"
