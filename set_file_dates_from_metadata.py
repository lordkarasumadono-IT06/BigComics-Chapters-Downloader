#!/usr/bin/env python3
"""
Sets a downloaded comic page's OS file dates (Created + Modified) to match the
publication date already embedded in the image itself by BigComics Chapter
Downloader (PNG "Creation Time" iTXt/tEXt chunk, or JPEG/WEBP EXIF DateTime tag).

Browsers always stamp a downloaded file with "now" — there is no way for a
webpage's JS to set the OS-level file date at download time, so this has to be
a separate, after-the-fact step. No external dependencies (stdlib only).

Usage:
    python set_file_dates_from_metadata.py <folder or files...>

Recurses into any given folder; only touches .png/.jpg/.jpeg/.webp files.
"Modified" date works on any OS (os.utime). "Created" date is only settable on
Windows (uses the Win32 SetFileTime API via ctypes) — on other OSes it's skipped
with a note, since the concept mostly doesn't exist there anyway.
"""
import sys
import os
import re
import struct
import zlib
from pathlib import Path
from datetime import datetime


def extract_png_date(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    pos = 8
    while pos < len(data) - 8:
        length = struct.unpack('>I', data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if ctype == b'iTXt':
            kw, _, rest = chunk.partition(b'\x00')
            if kw == b'Creation Time':
                comp_flag = rest[0]
                rest = rest[2:]
                _lang, _, rest = rest.partition(b'\x00')
                _transkw, _, text = rest.partition(b'\x00')
                if comp_flag:
                    text = zlib.decompress(text)
                return text.decode('utf-8')
        elif ctype == b'tEXt':
            kw, _, val = chunk.partition(b'\x00')
            if kw == b'Creation Time':
                return val.decode('latin1')
        pos += 8 + length + 4
        if ctype == b'IEND':
            break
    return None


def parse_tiff_datetime(tiff):
    if tiff[:2] not in (b'II', b'MM'):
        return None
    fmt = '<' if tiff[:2] == b'II' else '>'
    ifd_offset = struct.unpack(fmt + 'I', tiff[4:8])[0]
    count = struct.unpack(fmt + 'H', tiff[ifd_offset:ifd_offset + 2])[0]
    p = ifd_offset + 2
    for _ in range(count):
        tag = struct.unpack(fmt + 'H', tiff[p:p + 2])[0]
        cnt = struct.unpack(fmt + 'I', tiff[p + 4:p + 8])[0]
        if tag == 0x0132:  # DateTime, ASCII
            if cnt <= 4:
                raw = tiff[p + 8:p + 8 + cnt]
            else:
                off = struct.unpack(fmt + 'I', tiff[p + 8:p + 12])[0]
                raw = tiff[off:off + cnt]
            return raw.rstrip(b'\x00').decode('ascii', errors='ignore')
        p += 12
    return None


def extract_jpeg_date(data):
    if data[:2] != b'\xff\xd8':
        return None
    pos = 2
    while pos < len(data) - 4:
        if data[pos] != 0xFF:
            break
        marker = data[pos + 1]
        if marker in (0xD8, 0xD9):
            pos += 2
            continue
        seg_len = struct.unpack('>H', data[pos + 2:pos + 4])[0]
        if marker == 0xE1 and data[pos + 4:pos + 10] == b'Exif\x00\x00':
            tiff = data[pos + 10:pos + 2 + seg_len]
            date = parse_tiff_datetime(tiff)
            if date:
                return date
        pos += 2 + seg_len
    return None


def parse_date_to_datetime(s):
    s = s.strip()
    for pat in ('%Y-%m-%d', '%Y:%m:%d %H:%M:%S', '%Y:%m:%d'):
        try:
            return datetime.strptime(s, pat)
        except ValueError:
            continue
    m = re.match(r'(\d{4})[:-](\d{2})[:-](\d{2})', s)
    if m:
        y, mo, d = map(int, m.groups())
        return datetime(y, mo, d)
    return None


def set_windows_creation_time(path, dt):
    import ctypes
    from ctypes import wintypes

    FILE_WRITE_ATTRIBUTES = 0x0100
    OPEN_EXISTING = 3
    FILE_FLAG_BACKUP_SEMANTICS = 0x02000000

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateFileW(
        str(path), FILE_WRITE_ATTRIBUTES, 0, None,
        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, None
    )
    if handle == -1 or handle == 0xFFFFFFFF:
        raise OSError(f"Could not open {path} for setting creation time")

    epoch_diff = 11644473600  # seconds between 1601-01-01 and 1970-01-01
    filetime = int((dt.timestamp() + epoch_diff) * 10_000_000)
    ft = wintypes.FILETIME(filetime & 0xFFFFFFFF, filetime >> 32)

    kernel32.SetFileTime(handle, ctypes.byref(ft), None, None)
    kernel32.CloseHandle(handle)


def process_file(path):
    data = path.read_bytes()
    ext = path.suffix.lower()
    date_str = None
    if ext == '.png':
        date_str = extract_png_date(data)
    elif ext in ('.jpg', '.jpeg', '.webp'):
        date_str = extract_jpeg_date(data)

    if not date_str:
        print(f"[skip] {path.name}: no embedded date found")
        return
    dt = parse_date_to_datetime(date_str)
    if not dt:
        print(f"[skip] {path.name}: could not parse date '{date_str}'")
        return

    ts = dt.timestamp()
    os.utime(path, (ts, ts))  # sets Modified (and Accessed) — cross-platform

    if sys.platform == 'win32':
        try:
            set_windows_creation_time(path, dt)
        except Exception as e:
            print(f"[warn] {path.name}: could not set Windows Created date: {e}")
    else:
        print(f"[note] {path.name}: 'Created' date is Windows-only, skipped on this OS")

    print(f"[ok]   {path.name}: dates set to {dt.date()}")


def main(args):
    if not args:
        print("Usage: python set_file_dates_from_metadata.py <folder or files...>")
        sys.exit(1)
    files = []
    for a in args:
        p = Path(a)
        if p.is_dir():
            files.extend(sorted(p.rglob('*')))
        else:
            files.append(p)
    for f in files:
        if f.is_file() and f.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'):
            process_file(f)


if __name__ == '__main__':
    main(sys.argv[1:])
