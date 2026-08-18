#!/usr/bin/env bash
#
# Build and push the hosted box image.
#
# This script exists because its absence was the bug. The first box image was
# built by hand on 2026-07-25 and never rebuilt, so the fleet ran Dispatch 2.8.10
# while the local install reached 2.27.0 — nineteen minor versions of drift, with
# no repeatable way to close it.
#
# It tags every build with the package version as well as `latest`, because the
# control plane compares that tag against what each box reports it is running.
# An untagged build is invisible to the update check: the box cannot be told it
# is behind something with no version.
#
#   ./scripts/build-box-image.sh                 # build + push, version from package.json
#   ./scripts/build-box-image.sh --no-push       # build only, to check the Dockerfile
#
# Requires: docker, and an AWS profile that can push to the ECR repository.
set -euo pipefail

PROFILE="${AWS_PROFILE:-os-prod}"
REGION="${AWS_REGION:-us-east-1}"
REPO="${DISPATCH_ECR_REPO:-dispatch-box}"
PUSH=1
[[ "${1:-}" == "--no-push" ]] && PUSH=0

cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"

ACCOUNT="$(aws --profile "$PROFILE" sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${REPO}"

echo "Building ${REPO}:${VERSION} for linux/arm64 (Fargate Graviton)…"

# --platform is not optional: the fleet runs ARM64, and an amd64 image fails at
# task start with an exec-format error that reads like a corrupt image.
docker build \
  --platform linux/arm64 \
  -f docker/hosted/Dockerfile \
  -t "${IMAGE}:${VERSION}" \
  -t "${IMAGE}:latest" \
  .

if [[ "$PUSH" == "0" ]]; then
  echo "Built ${IMAGE}:${VERSION} — not pushing (--no-push)."
  exit 0
fi

aws --profile "$PROFILE" ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

docker push "${IMAGE}:${VERSION}"
docker push "${IMAGE}:latest"

DIGEST="$(aws --profile "$PROFILE" ecr describe-images \
  --repository-name "$REPO" --image-ids imageTag="$VERSION" \
  --query 'imageDetails[0].imageDigest' --output text)"

cat <<EOF

Pushed ${IMAGE}:${VERSION}
       ${DIGEST}

Boxes do NOT pick this up on their own — that is deliberate. Each one rolls onto
it when it is rebuilt, from OS Admin → Workspaces → Rebuild, or by the person
pressing Update in their own workspace. Rebuilding replaces the task, so live
threads on that box end.
EOF
