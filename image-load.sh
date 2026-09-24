#!/usr/bin/env bash

set -Eeuo pipefail

image="${IMAGE:-agentic-rpmbuild:dev}"
node_selector="${NODE_SELECTOR:-katacontainers.io/kata-runtime=true}"
snapshotter="${SNAPSHOTTER:-erofs}"
platform="${PLATFORM:-linux/amd64}"

usage() {
    cat <<'EOF'
Usage: ./image-load.sh [NODE_NAME...]

Stream a local Docker image into containerd on Kata nodes, unpacked for the
kata-v2 snapshotter, so Pods can use it with imagePullPolicy: Never and no
registry. When no nodes are given, load every Ready node matching
NODE_SELECTOR.

Environment overrides:
  IMAGE          local image to load (default: agentic-rpmbuild:dev)
  NODE_SELECTOR  node label selector (default: katacontainers.io/kata-runtime=true)
  SNAPSHOTTER    containerd snapshotter used by kata-v2 (default: erofs)
  PLATFORM       platform to unpack (default: linux/amd64)
EOF
}

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
esac

for cmd in docker gzip kubectl kubectl-node_shell; do
    command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done
docker image inspect "$image" >/dev/null 2>&1 || die "local image not found: $image"

nodes=("$@")
if ((${#nodes[@]} == 0)); then
    mapfile -t nodes < <(
        kubectl get nodes -l "$node_selector" \
            -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .status.conditions[?(@.type=="Ready")]}{.status}{end}{"\n"}{end}' |
            awk -F '\t' '$2 == "True" { print $1 }'
    )
fi
((${#nodes[@]} > 0)) || die "no Ready nodes match '$node_selector'"

for node in "${nodes[@]}"; do
    printf 'Loading %s onto %s (snapshotter %s)...\n' "$image" "$node" "$snapshotter"
    # shellcheck disable=SC2016  # Expanded on the node.
    docker save "$image" | gzip -1 |
        kubectl node-shell "$node" -- \
            env SNAPSHOTTER="$snapshotter" PLATFORM="$platform" sh -ec '
                gunzip | ctr -n k8s.io images import --local \
                    --snapshotter "$SNAPSHOTTER" --platform "$PLATFORM" -
            '
done
