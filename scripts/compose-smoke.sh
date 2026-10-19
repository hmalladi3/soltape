#!/usr/bin/env bash
# Runs the README's offline command and checks the feed end to end (DLV-CI-006):
# @spec DLV-CI-006, DLV-CMP-002
# health reachable, SOL priced by three sources, degraded when Orca is dropped, ok again after restore.
set -euo pipefail
PORT="${SOLTAPE_PORT:-8080}"
REPLAY="${REPLAY_PORT:-8899}"
BASE="http://127.0.0.1:${PORT}"
cleanup() { docker compose --profile replay down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker compose --profile replay up -d ${SMOKE_BUILD:+--build}

wait_for() { # wait_for <seconds> <description> <command...>
  local deadline=$((SECONDS + $1)) what=$2; shift 2
  until "$@" >/dev/null 2>&1; do
    if ((SECONDS > deadline)); then echo "timed out waiting for: $what" >&2; docker compose --profile replay logs --tail 50 >&2; exit 1; fi
    sleep 1
  done
  echo "ok: $what"
}
status() { curl -fsS "$BASE/health" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).status))'; }
is_status() { [ "$(curl -sS "$BASE/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).status))')" = "$1" ]; }
three_sources() { curl -fsS "$BASE/price/SOL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).sources.length===3?0:1))'; }
control() { curl -fsS -X POST "http://127.0.0.1:${REPLAY}/control" -d "$1" >/dev/null; }

wait_for 120 "/health reachable" curl -fsS "$BASE/health"
wait_for 60 "health ok" is_status ok
wait_for 30 "SOL priced by three sources" three_sources
control '{"op":"drop","venue":"orca"}'
wait_for 15 "health degraded after dropping orca" is_status degraded
control '{"op":"restore","venue":"orca"}'
wait_for 60 "health ok after restore" is_status ok
echo "compose smoke test passed"
