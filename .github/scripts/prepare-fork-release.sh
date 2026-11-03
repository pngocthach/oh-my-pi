#!/usr/bin/env bash
# Prepare an ephemeral release commit by replaying the fork-only patch onto the
# latest upstream release. Only the workflow's release-tag step publishes a ref.
set -euo pipefail

upstream_repo="can1357/oh-my-pi"
fork_branch="fork/acp-ambient-mcp"
upstream_tag="${UPSTREAM_TAG:-}"

if [[ -z "$upstream_tag" ]]; then
  upstream_tag="$(gh release view --repo "$upstream_repo" --json tagName --jq .tagName)"
fi
if [[ ! "$upstream_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid upstream release tag: $upstream_tag" >&2
  exit 1
fi

git remote add upstream "https://github.com/${upstream_repo}.git"
git fetch --no-tags upstream \
  "refs/tags/${upstream_tag}:refs/tags/${upstream_tag}" \
  "refs/heads/main:refs/remotes/upstream/main"
git fetch --no-tags origin "refs/heads/${fork_branch}:refs/remotes/origin/${fork_branch}"

# Use upstream main as the patch boundary, rather than the release tag: if
# upstream main has commits newer than this release, those commits must not be
# accidentally replayed as part of the fork-only ACP patch.
base="$(git merge-base refs/remotes/upstream/main "refs/remotes/origin/${fork_branch}")"
if [[ -z "$base" ]]; then
  echo "Fork patch branch has no common ancestor with upstream main" >&2
  exit 1
fi

patch_count="$(git rev-list --count "$base"..refs/remotes/origin/"$fork_branch")"
if [[ "$patch_count" -eq 0 ]]; then
  echo "Fork patch branch contains no commits beyond upstream main" >&2
  exit 1
fi

# Detach before rebasing: only this throwaway checkout is moved. A conflict is
# intentionally fatal, leaving both remote branches and tags untouched.
git checkout --detach "refs/remotes/origin/${fork_branch}"
git -c user.name='Fork release automation' -c user.email='actions@users.noreply.github.com' \
  rebase --onto "$upstream_tag" "$base"

commit="$(git rev-parse HEAD)"
patch_id="$(git diff --binary "$base" "refs/remotes/origin/${fork_branch}" | git patch-id --stable | cut -d' ' -f1)"
if [[ -z "$patch_id" ]]; then
  echo "Could not derive a stable patch identifier for $fork_branch" >&2
  exit 1
fi
release_tag="${upstream_tag}+acp.${patch_id:0:12}"
{
  echo "upstream_tag=$upstream_tag"
  echo "commit=$commit"
  echo "release_tag=$release_tag"
} >> "$GITHUB_OUTPUT"
printf 'Prepared %s from upstream %s with patch branch %s\n' "$commit" "$upstream_tag" "$fork_branch"
