#!/bin/sh
# Give a mDNS-only Jupyter host a plain name that resolves from /etc/hosts.
#
# Why: on macOS a `*.local` name goes through mDNSResponder first — multicast query, retries, and
# only then the /etc/hosts entry. Measured on this machine: 5 020 ms per resolution. A name without
# the `.local` suffix skips mDNS entirely and resolves in well under a millisecond.
#
# The plugin no longer pays that cost per request (it caches the answer for the life of the
# process), so this is the last five seconds: one resolution per app start. It is optional.
#
# Usage:
#   sudo scripts/alias-host.sh aimax395 192.168.5.200
#
# Then point the plugin at the new name:
#   url: http://aimax395:9002/lab
set -eu

name=${1:-}
address=${2:-}

if [ -z "$name" ] || [ -z "$address" ]; then
  echo "usage: sudo $0 <name-without-.local> <address>" >&2
  exit 2
fi

case "$name" in
  *.*) echo "refusing: \"$name\" contains a dot; pass a plain name such as aimax395" >&2; exit 2 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "this needs root to edit /etc/hosts — run it with sudo" >&2
  exit 1
fi

if grep -Eq "[[:space:]]${name}([[:space:]]|$)" /etc/hosts; then
  echo "$name already resolves from /etc/hosts:"
  grep -E "[[:space:]]${name}([[:space:]]|$)" /etc/hosts
  exit 0
fi

backup="/etc/hosts.dsh-jupyterlab.$(date +%Y%m%d%H%M%S).bak"
cp /etc/hosts "$backup"
printf '%s\t%s\n' "$address" "$name" >> /etc/hosts
echo "added: $address $name (backup: $backup)"

# Drop the resolver's cache, or the old "no such host" answer survives this change.
dscacheutil -flushcache 2>/dev/null || true
killall -HUP mDNSResponder 2>/dev/null || true

echo "checking:"
dscacheutil -q host -a name "$name" 2>/dev/null || ping -c 1 -t 2 "$name" 2>&1 | head -2
