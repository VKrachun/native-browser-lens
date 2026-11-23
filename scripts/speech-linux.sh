#!/bin/sh
# Builds the Linux speech programs on Ubuntu 22.04, so they need glibc 2.34 at most: they start on
# Ubuntu 22.04, Debian 12 and RHEL 9 too. (Lens itself is a static musl program.) It runs in the
# ubuntu:22.04 container, on the computer's own architecture, from the repository root:
#
#   docker run --rm -v "$PWD:/src" -w /src ubuntu:22.04 sh scripts/speech-linux.sh speech-bin [vulkan]
#
# Ubuntu 22.04 has no glslc, which whisper.cpp's Vulkan shaders need: glslc and the Vulkan headers
# that match it come from conda-forge. The Vulkan library it links is the system's own.
set -eu
out=$1
gpu=${2:-}
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl build-essential cmake git binutils
curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain none
. "$HOME/.cargo/env"
rustup toolchain install
target=target/jammy
cargo build --release --locked -p lens-speech --target-dir "$target"
mkdir -p "$out"
cp "$target/release/lens-speech" "$out/lens-speech"

if [ -n "$gpu" ]; then
  apt-get install -y -q --no-install-recommends libvulkan-dev
  version=2.10.0-0
  case "$(uname -m)" in
    x86_64) platform=linux-64 sha=701f39c06f8e6a670a0e186c8479b9e5c0502a2f0cda6cef65d83bdd2875e8bd ;;
    aarch64) platform=linux-aarch64 sha=3bb56786e21b9b24024f599fe9185b4a59dc3f9f59937a42311ee583adbbb23c ;;
  esac
  curl -fsSL -o /usr/local/bin/micromamba \
    "https://github.com/mamba-org/micromamba-releases/releases/download/$version/micromamba-$platform"
  echo "$sha  /usr/local/bin/micromamba" | sha256sum -c -
  chmod +x /usr/local/bin/micromamba
  # Two folders: the headers' one becomes VULKAN_SDK, whose lib folder must not offer conda's
  # libstdc++ or libgomp to the linker.
  micromamba create -y -q -r /opt/mamba -p /opt/glslc -c conda-forge shaderc
  micromamba create -y -q -r /opt/mamba -p /opt/vulkan -c conda-forge libvulkan-headers
  rm -rf /opt/vulkan/lib
  PATH="/opt/glslc/bin:$PATH" VULKAN_SDK=/opt/vulkan \
    cargo build --release --locked -p lens-speech --features "$gpu" --target-dir "$target-gpu"
  cp "$target-gpu/release/lens-speech" "$out/lens-speech-gpu"
fi
# The container runs as root: give the files back to the folder's owner.
owner=$(stat -c %u:%g .)
chown "$owner" target
chown -R "$owner" "$out" target/jammy*
