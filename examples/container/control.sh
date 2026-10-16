#!/bin/sh
set -eu
MONORIPPER_CONTROL_TOKEN=$(cat /run/secrets/monoripper-control)
export MONORIPPER_CONTROL_TOKEN
exec bun /app/dist/cli.js "$@" --controller 127.0.0.1:50051 --project container-example --environment container
