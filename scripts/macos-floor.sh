#!/bin/sh
# Fails when a macOS program, .app bundle or .dmg needs a newer macOS than the floor (11.0 on
# Apple Silicon, 10.15 on Intel). Checks Mach-O minos, system-only dylibs, strong imports of
# macOS 13.3+ Accelerate ($NEWLAPACK/$ILP64) or macOS 15.0+ Metal symbols, Info.plist
# LSMinimumSystemVersion, and that DMGs use HFS+ rather than APFS.
#
#   sh scripts/macos-floor.sh 11.0 target/aarch64-apple-darwin/release/lens speech-bin
#   sh scripts/macos-floor.sh 11.0 dist/*.dmg
set -eu
floor=$1
shift
work=$(mktemp -d)
cleanup() {
  if [ -f "$work/mounts" ]; then
    while IFS= read -r mp; do
      hdiutil detach -force "$mp" >/dev/null 2>&1 || true
    done <"$work/mounts"
  fi
  rm -rf "$work"
}
trap cleanup EXIT

failed=0
i=0
set -- "$@"
paths_file="$work/paths"
: >"$paths_file"

for item in "$@"; do
  i=$((i + 1))
  case "$item" in
    *.dmg)
      if ! command -v hdiutil >/dev/null 2>&1; then
        echo "macos-floor: hdiutil is required to inspect $item" >&2
        exit 1
      fi
      info=$(hdiutil imageinfo "$item")
      if printf "%s\n" "$info" | grep -q "Apple_APFS"; then
        echo "macos-floor: $item uses APFS; build with -fs HFS+ so older macOS can mount it" >&2
        failed=1
      elif ! printf "%s\n" "$info" | grep -q "Apple_HFS"; then
        echo "macos-floor: $item has no Apple_HFS partition" >&2
        failed=1
      else
        echo "$item: HFS+"
      fi
      mp="$work/dmg-$i"
      mkdir -p "$mp"
      hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mp" "$item" >/dev/null
      printf "%s\n" "$mp" >>"$work/mounts"
      printf "%s\t%s\n" "$mp" "$item" >>"$paths_file"
      ;;
    *.tar.gz)
      dir="$work/tar-$i"
      mkdir -p "$dir"
      tar -xzf "$item" -C "$dir"
      printf "%s\t%s\n" "$dir" "$item" >>"$paths_file"
      ;;
    *)
      printf "%s\t%s\n" "$item" "$item" >>"$paths_file"
      ;;
  esac
done

python3 - "$floor" "$paths_file" <<'PY' || failed=1
import os
import plistlib
import struct
import sys

floor_str = sys.argv[1]
paths_file = sys.argv[2]

def parse_ver(text):
    parts = [int(p) for p in text.strip().split(".")]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])

def fmt_ver(ver):
    return f"{ver[0]}.{ver[1]}" if ver[2] == 0 else f"{ver[0]}.{ver[1]}.{ver[2]}"

def decode_packed_ver(val):
    return ((val >> 16) & 0xFFFF, (val >> 8) & 0xFF, val & 0xFF)

floor = parse_ver(floor_str)

MH_MAGIC = 0xFEEDFACE
MH_CIGAM = 0xCEFAEDFE
MH_MAGIC_64 = 0xFEEDFACF
MH_CIGAM_64 = 0xCFFAEDFE
FAT_MAGIC = 0xCAFEBABE
FAT_CIGAM = 0xBEBAFECA
FAT_MAGIC_64 = 0xCAFEBABF
FAT_CIGAM_64 = 0xBFBAFECA

LC_SYMTAB = 0x2
LC_LOAD_DYLIB = 0xC
LC_LOAD_WEAK_DYLIB = 0x80000018
LC_REEXPORT_DYLIB = 0x8000001F
LC_DYLD_INFO = 0x22
LC_DYLD_INFO_ONLY = 0x80000022
LC_VERSION_MIN_MACOSX = 0x24
LC_BUILD_VERSION = 0x32
LC_DYLD_CHAINED_FIXUPS = 0x80000034

ALLOWED_DYLIB_PREFIXES = (
    "/System/Library/",
    "/usr/lib/",
    "@rpath/",
    "@executable_path/",
    "@loader_path/",
)

def read_uleb(buf, pos):
    result = 0
    shift = 0
    while pos < len(buf):
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            break
        shift += 7
    return result, pos

def read_sleb(buf, pos):
    result = 0
    shift = 0
    b = 0
    while pos < len(buf):
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        shift += 7
        if (b & 0x80) == 0:
            break
    if b & 0x40:
        result |= -(1 << shift)
    return result, pos

def parse_bind_opcodes(buf, start, size, is_lazy):
    """Returns list of (symbol_name, is_weak)."""
    out = []
    pos = start
    end = start + size
    while pos < end:
        byte = buf[pos]
        pos += 1
        opcode = byte & 0xF0
        imm = byte & 0x0F
        if opcode == 0x00:  # BIND_OPCODE_DONE
            if not is_lazy:
                break
        elif opcode in (0x10, 0x30, 0x50, 0x90, 0xB0):
            pass
        elif opcode in (0x20, 0x70, 0x80, 0xA0):
            _, pos = read_uleb(buf, pos)
        elif opcode == 0x60:
            _, pos = read_sleb(buf, pos)
        elif opcode == 0xC0:
            _, pos = read_uleb(buf, pos)
            _, pos = read_uleb(buf, pos)
        elif opcode == 0xD0:  # BIND_OPCODE_THREADED
            if imm == 0:
                _, pos = read_uleb(buf, pos)
        elif opcode == 0x40:  # BIND_OPCODE_SET_SYMBOL_TRAILING_FLAGS_IMM
            nul = buf.index(0, pos)
            sym = buf[pos:nul].decode("utf-8", errors="replace")
            pos = nul + 1
            out.append((sym, bool(imm & 0x1)))
        else:
            break
    return out

def parse_chained_fixups(buf, slice_off, dataoff):
    """Parse LC_DYLD_CHAINED_FIXUPS imports; returns list of (symbol_name, is_weak)."""
    out = []
    base = slice_off + dataoff
    if base + 28 > len(buf):
        return out
    (_ver, _starts_off, imports_off, symbols_off, imports_count, imports_format, symbols_format) = (
        struct.unpack_from("<7I", buf, base)
    )
    if symbols_format != 0:
        return out
    pos = base + imports_off
    sym_base = base + symbols_off
    for _ in range(imports_count):
        if imports_format == 1:  # DYLD_CHAINED_IMPORT
            val = struct.unpack_from("<I", buf, pos)[0]
            pos += 4
            weak = bool((val >> 8) & 0x1)
            name_off = (val >> 9) & 0x7FFFFF
        elif imports_format == 2:  # DYLD_CHAINED_IMPORT_ADDEND
            val, _addend = struct.unpack_from("<Ii", buf, pos)
            pos += 8
            weak = bool((val >> 8) & 0x1)
            name_off = (val >> 9) & 0x7FFFFF
        elif imports_format == 3:  # DYLD_CHAINED_IMPORT_ADDEND64
            val, _addend = struct.unpack_from("<Qq", buf, pos)
            pos += 16
            weak = bool((val >> 16) & 0x1)
            name_off = (val >> 32) & 0xFFFFFFFF
        else:
            break
        nul = buf.index(0, sym_base + name_off)
        sym = buf[sym_base + name_off : nul].decode("utf-8", errors="replace")
        out.append((sym, weak))
    return out

def macho_slices(data):
    if len(data) < 32:
        return []
    magic_le = struct.unpack_from("<I", data, 0)[0]
    magic_be = struct.unpack_from(">I", data, 0)[0]
    if magic_le in (MH_MAGIC, MH_CIGAM, MH_MAGIC_64, MH_CIGAM_64):
        return [(0, len(data))]
    if magic_be in (FAT_MAGIC, FAT_CIGAM):
        nfat = struct.unpack_from(">I", data, 4)[0]
        if nfat == 0 or nfat > 32 or 8 + nfat * 20 > len(data):
            return []
        slices = []
        for i in range(nfat):
            _cpu, _sub, off, size, _align = struct.unpack_from(">5I", data, 8 + i * 20)
            if off + 32 <= len(data):
                sm = struct.unpack_from("<I", data, off)[0]
                if sm in (MH_MAGIC, MH_CIGAM, MH_MAGIC_64, MH_CIGAM_64):
                    slices.append((off, size))
        return slices
    if magic_be in (FAT_MAGIC_64, FAT_CIGAM_64):
        nfat = struct.unpack_from(">I", data, 4)[0]
        if nfat == 0 or nfat > 32 or 8 + nfat * 32 > len(data):
            return []
        slices = []
        for i in range(nfat):
            _cpu, _sub, off, size, _align, _res = struct.unpack_from(">IIQQII", data, 8 + i * 32)
            if off + 32 <= len(data):
                sm = struct.unpack_from("<I", data, off)[0]
                if sm in (MH_MAGIC, MH_CIGAM, MH_MAGIC_64, MH_CIGAM_64):
                    slices.append((off, size))
        return slices
    return []

errors = []
macho_count = 0

def check_slice(label, data, slice_off):
    magic = struct.unpack_from("<I", data, slice_off)[0]
    if magic == MH_MAGIC_64:
        endian, is64, hdr_size = "<", True, 32
    elif magic == MH_CIGAM_64:
        endian, is64, hdr_size = ">", True, 32
    elif magic == MH_MAGIC:
        endian, is64, hdr_size = "<", False, 28
    elif magic == MH_CIGAM:
        endian, is64, hdr_size = ">", False, 28
    else:
        return

    ncmds = struct.unpack_from(f"{endian}I", data, slice_off + 16)[0]
    off = slice_off + hdr_size

    minos = None
    dylibs = []
    # Map symbol -> has_strong_import; dyld bind/fixup tables override symtab when present.
    symtab_imports = {}
    dyld_imports = {}

    def record_import(table, sym, is_weak):
        if sym not in table:
            table[sym] = not is_weak
        elif not is_weak:
            table[sym] = True

    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from(f"{endian}II", data, off)
        if cmd == LC_BUILD_VERSION:
            platform, minos_raw, _sdk, _ntools = struct.unpack_from(f"{endian}IIII", data, off + 8)
            if platform in (1, 6):  # PLATFORM_MACOS, PLATFORM_MACCATALYST
                minos = decode_packed_ver(minos_raw)
        elif cmd == LC_VERSION_MIN_MACOSX:
            ver_raw = struct.unpack_from(f"{endian}I", data, off + 8)[0]
            minos = decode_packed_ver(ver_raw)
        elif cmd in (LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB):
            str_off = struct.unpack_from(f"{endian}I", data, off + 8)[0]
            nul = data.index(0, off + str_off)
            dylibs.append(data[off + str_off : nul].decode("utf-8", errors="replace"))
        elif cmd == LC_SYMTAB:
            symoff, nsyms, stroff, _strsize = struct.unpack_from(f"{endian}IIII", data, off + 8)
            stride = 16 if is64 else 12
            fmt = f"{endian}IBBHQ" if is64 else f"{endian}IBBHI"
            for i in range(nsyms):
                n_strx, n_type, _n_sect, n_desc, _n_val = struct.unpack_from(
                    fmt, data, slice_off + symoff + i * stride
                )
                # External undefined symbol (N_EXT=0x01, N_TYPE=0x0e == N_UNDF=0x00, not N_STAB)
                if (n_type & 0xE0) == 0 and (n_type & 0x0E) == 0 and (n_type & 0x01):
                    if n_strx != 0:
                        nul = data.index(0, slice_off + stroff + n_strx)
                        sym = data[slice_off + stroff + n_strx : nul].decode("utf-8", errors="replace")
                        is_weak = bool(n_desc & 0x0040)  # N_WEAK_REF
                        record_import(symtab_imports, sym, is_weak)
        elif cmd in (LC_DYLD_INFO, LC_DYLD_INFO_ONLY):
            (
                _rebase_off,
                _rebase_size,
                bind_off,
                bind_size,
                _weak_off,
                _weak_size,
                lazy_off,
                lazy_size,
                _export_off,
                _export_size,
            ) = struct.unpack_from(f"{endian}10I", data, off + 8)
            if bind_size:
                for sym, is_weak in parse_bind_opcodes(data, slice_off + bind_off, bind_size, False):
                    record_import(dyld_imports, sym, is_weak)
            if lazy_size:
                for sym, is_weak in parse_bind_opcodes(data, slice_off + lazy_off, lazy_size, True):
                    record_import(dyld_imports, sym, is_weak)
        elif cmd == LC_DYLD_CHAINED_FIXUPS:
            dataoff, _datasize = struct.unpack_from(f"{endian}II", data, off + 8)
            for sym, is_weak in parse_chained_fixups(data, slice_off, dataoff):
                record_import(dyld_imports, sym, is_weak)
        off += cmdsize

    ok = True
    if minos is None:
        errors.append(f"{label}: missing LC_BUILD_VERSION / LC_VERSION_MIN_MACOSX")
        ok = False
    elif minos > floor:
        errors.append(f"{label}: requires macOS {fmt_ver(minos)}, newer than {floor_str}")
        ok = False

    for dylib in dylibs:
        if not dylib.startswith(ALLOWED_DYLIB_PREFIXES):
            errors.append(f"{label}: links non-system library {dylib}")
            ok = False

    imports = {**symtab_imports, **dyld_imports}
    for sym, is_strong in sorted(imports.items()):
        if not is_strong:
            continue
        if floor < (13, 3, 0) and ("$NEWLAPACK" in sym or "$ILP64" in sym):
            errors.append(f"{label}: strongly imports {sym} (requires macOS 13.3+)")
            ok = False
        if floor < (15, 0, 0) and sym == "_OBJC_CLASS_$_MTLResidencySetDescriptor":
            errors.append(f"{label}: strongly imports {sym} (requires macOS 15.0+)")
            ok = False

    if ok:
        print(f"{label}: macOS {fmt_ver(minos)}")

def check_app_plist(plist_path, label):
    with open(plist_path, "rb") as f:
        info = plistlib.load(f)
    min_sys = info.get("LSMinimumSystemVersion")
    if not min_sys:
        errors.append(f"{label}: missing LSMinimumSystemVersion")
        return
    try:
        parsed = parse_ver(str(min_sys))
    except ValueError:
        errors.append(f"{label}: invalid LSMinimumSystemVersion {min_sys!r}")
        return
    if parsed > floor:
        errors.append(f"{label}: LSMinimumSystemVersion is {min_sys}, newer than {floor_str}")
    else:
        print(f"{label}: LSMinimumSystemVersion {min_sys}")

def rel_label(path, root, display_root):
    if path == root:
        return display_root
    rel = os.path.relpath(path, root)
    return f"{display_root}/{rel}"

with open(paths_file, "r", encoding="utf-8") as f:
    entries = [line.rstrip("\n").split("\t", 1) for line in f if line.strip()]

for root, display_root in entries:
    if os.path.isfile(root):
        files = [root]
    elif os.path.isdir(root):
        files = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            if dirpath.endswith(".app"):
                plist_path = os.path.join(dirpath, "Contents", "Info.plist")
                if os.path.isfile(plist_path):
                    check_app_plist(plist_path, rel_label(plist_path, root, display_root))
            for fn in sorted(filenames):
                full = os.path.join(dirpath, fn)
                if not os.path.islink(full):
                    files.append(full)
    else:
        errors.append(f"{display_root}: path does not exist")
        continue

    for path in files:
        try:
            with open(path, "rb") as fh:
                head = fh.read(4)
                if len(head) < 4:
                    continue
                m_le = struct.unpack("<I", head)[0]
                m_be = struct.unpack(">I", head)[0]
                if m_le not in (MH_MAGIC, MH_CIGAM, MH_MAGIC_64, MH_CIGAM_64) and m_be not in (
                    FAT_MAGIC,
                    FAT_CIGAM,
                    FAT_MAGIC_64,
                    FAT_CIGAM_64,
                ):
                    continue
                fh.seek(0)
                data = fh.read()
        except OSError as exc:
            errors.append(f"{rel_label(path, root, display_root)}: {exc}")
            continue
        slices = macho_slices(data)
        if not slices:
            continue
        macho_count += 1
        label = rel_label(path, root, display_root)
        for slice_off, _size in slices:
            check_slice(label, data, slice_off)

if macho_count == 0:
    errors.append("no Mach-O binaries found")

if errors:
    for err in errors:
        print(f"macos-floor: {err}", file=sys.stderr)
    sys.exit(1)
PY

[ "$failed" -eq 0 ]
