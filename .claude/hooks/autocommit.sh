#!/usr/bin/env bash
#
# Stop hook — commit and push whatever is left in the working tree.
#
# Deliberately automatic rather than block-and-remind: work that is not pushed is not
# shipped. On main it is the other way round — see PROTECTED below.
#
# Pushing does NOT move staging. Staging deploys the highest `v*` tag on origin, polled
# once a minute; a push to a branch, main included, changes nothing there. (The older
# note here said a push restarts staging and stops its previews. That was true of the
# deploy-every-commit setup it was written for, and measured false on 2026-09-21: nine
# pushes to main left staging on the commit it was already running.)
#
# No `set -e`: a hook that dies mid-way leaves a half-staged tree and says nothing.
# Every step reports through say() instead.
set -uo pipefail

# Work is branched off main, reviewed as a PR, and reaches main by merge (agreed
# 2026-09-21). Uncommitted work sitting on main is therefore a mistake to report, not
# something to record — committing it here is what that workflow exists to prevent.
# Commits already on main are still pushed: those arrive by merge and belong upstream.
PROTECTED=main

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# The message is the entire output of this hook, and on a refusal it is the only thing
# standing between the user and silently uncommitted work — so it cannot depend on jq
# being installed. It is not: the code-server container has no jq, which is why this
# hook reported nothing at all for the whole of 2026-09-21.
say() {
  local m=$1
  if command -v jq >/dev/null 2>&1; then
    jq -nc --arg m "$m" '{systemMessage:$m}'
  else
    # Only these three can break a JSON string literal here; the messages are plain text.
    m=${m//\\/\\\\}
    m=${m//\"/\\\"}
    m=${m//$'\n'/ }
    printf '{"systemMessage":"%s"}\n' "$m"
  fi
  exit 0
}

# Never commit on top of a half-finished merge, rebase, cherry-pick or bisect —
# `git add -A` there would silently resolve conflicts by staging the markers.
gitdir=$(git rev-parse --git-dir)
for marker in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD BISECT_LOG rebase-merge rebase-apply; do
  [ -e "$gitdir/$marker" ] && say "autocommit skipped: $marker in progress"
done

branch=$(git symbolic-ref --short -q HEAD) || say "autocommit skipped: detached HEAD"

# Every file, one per line, unquoted: by default an untracked directory is listed as `dir/`
# alone, so the secret check below never saw a `dir/.env` that `git add -A` then pushed, and a
# path with a space came back quoted, past the check's `$`. --no-renames, or -z gives a rename
# its old path as a line of its own. cut -c4- rather than awk: it keeps spaces in one piece.
files=$(git status --porcelain -z --untracked-files=all --no-renames | tr '\0' '\n' | cut -c4-)

# Set rather than said, so that a refusal still lets the push below run and is reported
# together with it. say() ends the hook, and a refusal is not the end of the hook.
refused=""

if [ -n "$files" ]; then
  n=$(grep -c . <<<"$files")

  if [ "$branch" = "$PROTECTED" ]; then
    # Refused, not lost: `git switch -c` carries a dirty tree onto the new branch, so the
    # work stays exactly where it is, one command away from being recorded.
    refused="autocommit REFUSED — $n uncommitted change(s) on $PROTECTED. Run 'git switch -c <branch>': the changes come with you, and the next turn commits them there."
  else
    # .gitignore covers the secrets we know about, but this hook pushes to a remote with
    # nobody watching, so an untracked key that was never ignored must stop it, not ride along.
    secrets=$(grep -Ei '(^|/)(\.env([.-].*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_[a-z]+)$' <<<"$files")
    [ -n "$secrets" ] && say "autocommit REFUSED — looks like a secret: $(tr '\n' ' ' <<<"$secrets")commit it yourself if it is fine"

    summary=$(head -3 <<<"$files" | tr '\n' ' ')
    [ "$n" -gt 3 ] && summary="${summary}(+$((n - 3)) more)"

    git add -A || say "autocommit failed at git add"
    git commit -q \
      -m "chore: autocommit — ${summary% }" \
      -m "Committed unattended by .claude/hooks/autocommit.sh, so the message is generic. Rewrite it before the PR is reviewed: commit --amend, then push --force-with-lease." \
      -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" \
      || say "autocommit failed at git commit"
  fi
fi

# Push even when the tree was already clean: a commit made earlier and never pushed is
# just as unshipped, which is the failure this hook exists to stop.
if [ "$(git rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 1)" = "0" ]; then
  [ -n "$refused" ] && say "$refused"
  exit 0
fi

if out=$(git push origin "$branch" 2>&1); then
  say "${refused:+$refused }autocommit: pushed $branch"
else
  say "${refused:+$refused }autocommit: push failed — $(tail -1 <<<"$out")"
fi
