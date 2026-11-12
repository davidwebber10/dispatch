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
#   ./scripts/build-box-image.sh --no-push       # build only, to check the Dockerfile (no AWS call)
#
# Options (the defaults are what the script always did: os-prod, us-east-1, dispatch-box, arm64):
#   --profile <aws profile>     AWS profile (default $AWS_PROFILE or os-prod)
#   --account <id>              AWS account id (default: asked of `aws sts` — only when pushing)
#   --region <region>           default $AWS_REGION or us-east-1
#   --repo <name>               ECR repository (default $DISPATCH_ECR_REPO or dispatch-box)
#   --platform <p>              default linux/arm64 (Fargate Graviton); linux/amd64 for a local x86 test
#   --local-tag <name>          with --no-push: the local image name (default dispatch-box), no registry
#   --tag <tag>                 the image tag (default: the version in package.json)
#   --no-latest                 do not tag or push `latest` (a build for one environment to try first)
#   --target <stage>            the Dockerfile stage: `runtime` (default, the standard image) or
#                               `runtime-dev` (the developer image: toolchain, approvals may be skipped).
#                               Give the developer image its own --tag; it never becomes `latest`.
#
# The agent CLIs are pinned in the Dockerfile (Claude Code: version and SHA-256 of the binary) and in
# docker/hosted/agent-clis/package-lock.json (Codex, OpenCode, mcp-remote: every package by integrity
# hash). To move one, change the pin there; there is no version option here any more.
#
# Requires: docker, and (to push) an AWS profile that can push to the ECR repository.
set -euo pipefail

PROFILE="${AWS_PROFILE:-os-prod}"
REGION="${AWS_REGION:-us-east-1}"
REPO="${DISPATCH_ECR_REPO:-dispatch-box}"
ACCOUNT=""
PLATFORM="linux/arm64"
LOCAL_TAG="dispatch-box"
BUILD_ARGS=()
PUSH=1
TAG=""
LATEST=1
TARGET="runtime"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-push) PUSH=0 ;;
    --profile) PROFILE="$2"; shift ;;
    --account) ACCOUNT="$2"; shift ;;
    --region) REGION="$2"; shift ;;
    --repo) REPO="$2"; shift ;;
    --platform) PLATFORM="$2"; shift ;;
    --local-tag) LOCAL_TAG="$2"; shift ;;
    --tag) TAG="$2"; shift ;;
    --no-latest) LATEST=0 ;;
    --target) TARGET="$2"; shift ;;
    --claude|--codex|--opencode) echo "$1 is gone: the agent CLIs are pinned by hash (see the header of this script)." >&2; exit 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$(dirname "$0")/.."
VERSION="${TAG:-$(node -p "require('./package.json').version")}"
# The developer image is never `latest`: `latest` is what a new box gets.
[[ "$TARGET" == "runtime" ]] || LATEST=0

if [[ "$PUSH" == "0" && -z "$ACCOUNT" ]]; then
  # A true local-only build: no AWS call at all.
  IMAGE="${LOCAL_TAG}"
else
  [[ -n "$ACCOUNT" ]] || ACCOUNT="$(aws --profile "$PROFILE" sts get-caller-identity --query Account --output text)"
  REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
  IMAGE="${REGISTRY}/${REPO}"
fi

echo "Building ${IMAGE}:${VERSION} for ${PLATFORM}…"

# --platform is not optional: the fleet runs ARM64, and an amd64 image fails at
# task start with an exec-format error that reads like a corrupt image.
TAGS=(-t "${IMAGE}:${VERSION}")
[[ "$LATEST" == "1" ]] && TAGS+=(-t "${IMAGE}:latest")
docker build \
  --platform "${PLATFORM}" \
  --target "${TARGET}" \
  -f docker/hosted/Dockerfile \
  ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} \
  "${TAGS[@]}" \
  .

if [[ "$PUSH" == "0" ]]; then
  echo "Built ${IMAGE}:${VERSION} — not pushing (--no-push)."
  exit 0
fi

aws --profile "$PROFILE" ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

docker push "${IMAGE}:${VERSION}"
[[ "$LATEST" == "1" ]] && docker push "${IMAGE}:latest"

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
