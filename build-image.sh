#!/usr/bin/env bash

set -Eeuo pipefail

azldev_repo="${AZLDEV_REPO:-$HOME/repos/azure-linux-dev-tools}"
base_image="${BASE_IMAGE:-azldev-scenario:agent}"
image="${IMAGE:-agentic-rpmbuild:dev}"
azl_repo_url="${AZL_REPO_URL:-https://github.com/Camelron/azurelinux.git}"
azl_ref="${AZL_REF:-cameronbaird/4.0/broken-packages}"

usage() {
    cat <<'EOF'
Usage: ./build-image.sh

Build the agent image: the azldev scenario image from azure-linux-dev-tools,
plus the azldev binary and an azurelinux checkout baked in.

Environment overrides:
  AZLDEV_REPO   azure-linux-dev-tools checkout with out/bin/azldev built
                (default: ~/repos/azure-linux-dev-tools)
  BASE_IMAGE    tag for the scenario base image (default: azldev-scenario:agent)
  IMAGE         tag for the agent image (default: agentic-rpmbuild:dev)
  AZL_REPO_URL  azurelinux clone URL; agents push topic branches here
                (default: https://github.com/Camelron/azurelinux.git)
  AZL_REF       azurelinux branch to clone
                (default: cameronbaird/4.0/broken-packages)
EOF
}

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    "") ;;
    *) die "unexpected argument: $1" ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
azldev_bin_dir="$azldev_repo/out/bin"

[[ -f "$azldev_repo/scenario/docker/Dockerfile" ]] ||
    die "scenario Dockerfile not found under $azldev_repo"
[[ -x "$azldev_bin_dir/azldev" ]] ||
    die "$azldev_bin_dir/azldev not found; build azldev first"

# Fixed IDs: nothing is bind-mounted from the host in Kubernetes.
docker build \
    --build-arg UID=1000 \
    --build-arg GID=1000 \
    --build-arg WORK_DIR=/workdir \
    --build-arg TIMESTAMP="$(date -u +%Y-%m-%d)" \
    --file "$azldev_repo/scenario/docker/Dockerfile" \
    --tag "$base_image" \
    "$azldev_repo/scenario/docker"

docker build \
    --build-arg BASE_IMAGE="$base_image" \
    --build-arg AZL_REPO_URL="$azl_repo_url" \
    --build-arg AZL_REF="$azl_ref" \
    --build-context azldev="$azldev_bin_dir" \
    --tag "$image" \
    "$script_dir/image"

printf 'Built %s\n' "$image"
