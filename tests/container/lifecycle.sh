#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
bun tests/container/lifecycle.ts
exec bun tests/container/startup.ts
