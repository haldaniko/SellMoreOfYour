#!/bin/sh
set -eu
owner="$(stat -c '%u:%g' /data)"
exec su-exec "$owner" "$@"
