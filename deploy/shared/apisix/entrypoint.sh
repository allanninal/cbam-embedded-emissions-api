#!/bin/sh
# Render the APISIX route table with the Redis password from the environment,
# then start APISIX. Keeps the secret out of the committed config.
set -e

SRC=/opt/apisix.yaml.tmpl
DST=/usr/local/apisix/conf/apisix.yaml

if [ -z "$REDIS_PASSWORD" ]; then
  echo "WARNING: REDIS_PASSWORD is empty; rate-limit Redis auth will fail." >&2
fi

# Substitute the placeholder with the real password (escaped for sed).
esc=$(printf '%s' "$REDIS_PASSWORD" | sed -e 's/[\/&]/\\&/g')
sed "s/__REDIS_PASSWORD__/${esc}/g" "$SRC" > "$DST"

echo "APISIX route table rendered to $DST"
exec /docker-entrypoint.sh docker-start
