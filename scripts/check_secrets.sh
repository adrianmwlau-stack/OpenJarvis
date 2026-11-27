#!/bin/sh
# check_secrets.sh — refuse to commit a live credential.
#
# Works two ways:
#   scripts/check_secrets.sh FILE...   # pre-commit framework passes filenames
#   scripts/check_secrets.sh           # no args: scans staged additions
#
# Deliberately high-signal: it matches real credential shapes, not the words
# "api_key" or "secret", so prose and test fixtures stay committable.
# Bypass for a genuine false positive: git commit --no-verify

set -u

patterns='sk-ant-[A-Za-z0-9_-]{20,}
sk-[a-f0-9]{32}
sk-[A-Za-z0-9]{40,}
ghp_[A-Za-z0-9]{30,}
gho_[A-Za-z0-9]{30,}
github_pat_[A-Za-z0-9_]{40,}
AKIA[0-9A-Z]{16}
xox[baprs]-[A-Za-z0-9-]{10,}
AIza[0-9A-Za-z_-]{35}
-----BEGIN [A-Z ]*PRIVATE KEY-----'

found=0

check_text() {
    text=$1
    label=$2
    old_ifs=$IFS
    IFS='
'
    for p in $patterns; do
        [ -z "$p" ] && continue
        if printf '%s\n' "$text" | grep -Eq -- "$p"; then
            echo "check_secrets: blocked — $label matches a credential pattern:" >&2
            printf '%s\n' "$text" | grep -En -- "$p" | sed 's/^/    /' >&2
            found=1
        fi
    done
    IFS=$old_ifs
}

if [ "$#" -gt 0 ]; then
    for f in "$@"; do
        [ -f "$f" ] || continue
        case "$f" in
            .env|*/.env|*.pem|*id_rsa*|*.p12|*.pfx)
                echo "check_secrets: blocked — sensitive filename: $f" >&2
                found=1
                continue
                ;;
        esac
        check_text "$(cat "$f" 2>/dev/null || true)" "$f"
    done
else
    staged=$(git diff --cached --name-only --diff-filter=ACMR)
    [ -z "$staged" ] && exit 0
    for f in $staged; do
        case "$f" in
            .env|*/.env|*.pem|*id_rsa*|*.p12|*.pfx)
                echo "check_secrets: blocked — sensitive filename staged: $f" >&2
                found=1
                continue
                ;;
        esac
    done
    added=$(git diff --cached --diff-filter=ACMR -U0 | grep '^+' | grep -v '^+++')
    check_text "$added" "staged additions"
fi

if [ "$found" -eq 1 ]; then
    echo "" >&2
    echo "Secrets belong in environment variables, not in the repository." >&2
    echo "This machine keeps them in user env vars, synced by ~/.openjarvis/sync-brains.ps1." >&2
    exit 1
fi

exit 0
