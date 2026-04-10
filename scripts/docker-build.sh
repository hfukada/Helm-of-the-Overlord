#!/bin/bash
set -euo pipefail
export GIT_COMMIT=$(git rev-parse HEAD)
export GIT_DATETIME=$(git log -1 --format=%cI)
exec docker compose build "$@"
