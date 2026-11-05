#!/usr/bin/env bash
# Stealth scan. Reads the term list from .local/stealth-terms.txt (gitignored; one term per line)
# and reports hits by term number and location only. It never prints a term or a matching line.
#
#   bash scripts/stealth-scan.sh                  tracked file contents, tracked paths, and the full
#                                                 history (git log -p --all, which includes messages)
#   bash scripts/stealth-scan.sh --staged         the staged diff only (run before a commit)
#   bash scripts/stealth-scan.sh --range A..B     the commits in a range (run before a merge)
#   bash scripts/stealth-scan.sh --files F...     any files, for example page text saved before a screenshot
#
# Rule (brief, Phase 5; plan decision 7): case-insensitive substring match for every term, except
# that a term of 3 characters or fewer must stand between non-alphanumeric boundaries (it occurs
# by chance inside base64 lockfile hashes). Exit 1 on any hit.
set -euo pipefail

# The extended regex for a term: the escaped term, bounded when it has 3 characters or fewer.
pattern_for() {
  local esc
  esc="$(printf '%s' "$1" | sed 's/[][\.*^$+?(){}|/]/\\&/g')"
  if [[ ${#1} -le 3 ]]; then
    printf '(^|[^[:alnum:]])%s([^[:alnum:]]|$)' "$esc"
  else
    printf '%s' "$esc"
  fi
}

root="$(git rev-parse --show-toplevel)"
terms_file="$root/.local/stealth-terms.txt"
if [[ ! -s "$terms_file" ]]; then
  echo "stealth-scan: $terms_file is missing or empty. Nothing was scanned." >&2
  exit 2
fi

mode="${1:-all}"
hits=0

# Reads the text to scan on stdin and reports each term's match count by number.
count_stream() {
  local label="$1" text n i=0
  text="$(cat)"
  while IFS= read -r term || [[ -n "$term" ]]; do
    i=$((i + 1))
    [[ -z "$term" ]] && continue
    n="$(printf '%s' "$text" | grep -c -i -E -e "$(pattern_for "$term")" || true)"
    if [[ "$n" != "0" ]]; then
      echo "HIT term #$i: $n matching lines in $label"
      hits=$((hits + n))
    fi
  done <"$terms_file"
}

# Reports file:line for each hit in the given files, without the line text.
locate_in_files() {
  local i=0 out
  while IFS= read -r term || [[ -n "$term" ]]; do
    i=$((i + 1))
    [[ -z "$term" ]] && continue
    out="$(grep -n -i -E -H -e "$(pattern_for "$term")" -- "$@" 2>/dev/null | cut -d: -f1,2 || true)"
    if [[ -n "$out" ]]; then
      while IFS= read -r loc; do
        echo "HIT term #$i: $loc"
        hits=$((hits + 1))
      done <<<"$out"
    fi
  done <"$terms_file"
}

cd "$root"
case "$mode" in
  all)
    i=0
    while IFS= read -r term || [[ -n "$term" ]]; do
      i=$((i + 1))
      [[ -z "$term" ]] && continue
      out="$(git grep -n -i -E -I -e "$(pattern_for "$term")" -- . 2>/dev/null | cut -d: -f1,2 || true)"
      if [[ -n "$out" ]]; then
        while IFS= read -r loc; do
          echo "HIT term #$i: tracked file $loc"
          hits=$((hits + 1))
        done <<<"$out"
      fi
    done <"$terms_file"
    git ls-files | count_stream "tracked paths"
    git log -p --all --no-color | count_stream "git log -p --all"
    ;;
  --staged)
    git diff --cached --no-color | count_stream "the staged diff"
    ;;
  --range)
    range="${2:?usage: stealth-scan.sh --range A..B}"
    git log -p --no-color "$range" | count_stream "git log -p $range"
    ;;
  --files)
    shift
    [[ $# -gt 0 ]] || { echo "usage: stealth-scan.sh --files F..." >&2; exit 2; }
    locate_in_files "$@"
    ;;
  *)
    echo "usage: stealth-scan.sh [--staged | --range A..B | --files F...]" >&2
    exit 2
    ;;
esac

terms="$(grep -c . "$terms_file")"
if [[ "$hits" -gt 0 ]]; then
  echo "stealth-scan: $hits hits for $terms terms ($mode). Stop and ask Nate before any push."
  exit 1
fi
echo "stealth-scan: 0 hits for $terms terms ($mode)."
