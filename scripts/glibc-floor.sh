#!/bin/sh
# Fails when a Linux program needs a newer glibc than the floor: 2.34, RHEL 9's, the oldest glibc
# the Linux packages support (Ubuntu 22.04 has 2.35, Debian 12 2.36). It reads programs, folders,
# and .deb, .AppImage and .tar.gz packages, and checks every ELF file in them.
#
#   sh scripts/glibc-floor.sh 2.34 dist/*.deb dist/*.AppImage dist/*-pacman.tar.gz speech-bin
set -eu
floor=$1
shift
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for item in "$@"; do
  dir="$work/$(basename "$item")"
  case "$item" in
    *.deb) mkdir -p "$dir" && dpkg-deb -x "$item" "$dir" ;;
    *.AppImage) mkdir -p "$dir" && cp "$item" "$dir/app" && chmod +x "$dir/app" &&
      (cd "$dir" && ./app --appimage-extract >/dev/null) && rm "$dir/app" ;;
    *.tar.gz) mkdir -p "$dir" && tar -xzf "$item" -C "$dir" ;;
    *) dir=$item ;;
  esac
  find "$dir" -type f -print >"$work/files"
  while IFS= read -r file; do
    [ "$(head -c 4 "$file" | od -An -c | tr -d ' ')" = '177ELF' ] || continue
    needed=$(objdump -T "$file" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -n 1)
    [ -n "$needed" ] || continue
    if [ "$(printf '%s\n%s\n' "$floor" "$needed" | sort -V | tail -n 1)" != "$floor" ]; then
      echo "glibc-floor: ${file#"$work"/} needs glibc $needed, newer than $floor" >&2
      echo failed >"$work/failed"
    else
      echo "${file#"$work"/}: glibc $needed"
    fi
  done <"$work/files"
done
[ ! -e "$work/failed" ]
