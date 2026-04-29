#!/bin/bash
set -euo pipefail

if [[ "${OPENGUI_HOST_EXEC:-0}" == "1" ]]; then
	export PATH="/usr/local/host-bin:$PATH"
	: "${OPENGUI_HOST_UID:=0}"
	: "${OPENGUI_HOST_GID:=0}"
	: "${OPENGUI_HOST_HOME:=/root}"
	export HOME="$OPENGUI_HOST_HOME"
	echo "OpenGUI Docker host-control mode enabled"
	echo "  host uid/gid: $OPENGUI_HOST_UID:$OPENGUI_HOST_GID"
	echo "  host home: $OPENGUI_HOST_HOME"
	echo "  allowed roots: ${OPENGUI_ALLOWED_ROOTS:-unset}"
else
	echo "OpenGUI Docker contained mode enabled"
fi

exec "$@"
