"""Parallel GPS scanning of uploaded ZIP archives with exiftool.

Two consumers:

* ``scan_members_parallel`` / ``extract_and_scan_zip_parallel`` — scan a
  complete archive on disk (used by the direct multipart endpoints in
  api.py and by the final reconcile of chunked uploads).
* ``zip_stream_scan.ZipStreamScanner`` — scans image entries while a
  chunked upload is still in flight; it reuses ``read_gps_from_file``
  so both paths parse exiftool output identically.

Fail-soft guarantees:
* An individual bad image is counted as "without GPS" and never aborts
  the whole scan.
* Each extracted file is deleted immediately after its scan, so even a
  15-20 GB archive cannot fill the temp disk.
* A missing exiftool binary raises instead of silently reporting every
  image as "without GPS".
"""

import logging
import os
import shutil
import subprocess
import tempfile
import zipfile
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.bmp', '.gif')

# exiftool runs are subprocess-bound, so a modest multiple of the CPU
# count is plenty; beyond ~12 workers the disk becomes the bottleneck.
SCAN_WORKERS = max(4, min(12, (os.cpu_count() or 4) * 2))
PER_IMAGE_TIMEOUT = 30  # seconds per single image


def zip_image_members(zip_path):
    """List image members of the archive in stable, sorted order."""
    with zipfile.ZipFile(zip_path, 'r') as zf:
        members = [
            m for m in zf.namelist()
            if m.lower().endswith(IMAGE_EXTENSIONS)
            and not m.startswith('__MACOSX')
            and not m.endswith('/')  # skip directory entries
        ]
    members.sort()
    return members


def _read_gps(exif_output):
    """Parse default exiftool output into (lat, lon), applying N/S/E/W refs."""
    # Lazy import: keeps this module usable by uploads.py without pulling
    # in functions.py (which drags streamlit along with it).
    from functions import dms_to_decimal

    lat = lon = None
    lat_ref = lon_ref = ''

    for line in exif_output.split('\n'):
        if 'GPS Latitude' in line and 'Ref' not in line:
            try:
                lat = dms_to_decimal(line.split(':', 1)[1].strip())
            except Exception:
                pass
        elif 'GPS Longitude' in line and 'Ref' not in line:
            try:
                lon = dms_to_decimal(line.split(':', 1)[1].strip())
            except Exception:
                pass
        elif 'GPS Latitude Ref' in line:
            lat_ref = line.split(':', 1)[1].strip()
        elif 'GPS Longitude Ref' in line:
            lon_ref = line.split(':', 1)[1].strip()

    # dms_to_decimal ignores the hemisphere letter embedded in the DMS
    # string, so the sign comes from the Ref lines. exiftool prints them
    # as full words ("South"/"West"), hence the prefix match.
    if lat is not None and lat_ref.upper().startswith('S'):
        lat = -lat
    if lon is not None and lon_ref.upper().startswith('W'):
        lon = -lon
    return lat, lon


def read_gps_from_file(path, env=None, timeout=PER_IMAGE_TIMEOUT):
    """Run exiftool on one image file and return (lat, lon)."""
    if env is None:
        env = os.environ.copy()
    result = subprocess.run(
        ['exiftool', '-GPSLatitude', '-GPSLongitude',
         '-GPSLatitudeRef', '-GPSLongitudeRef', path],
        capture_output=True, text=True, env=env,
        timeout=timeout,
    )
    return _read_gps(result.stdout)


def _scan_one(zip_path, member, extract_dir):
    """Extract one member and read its GPS tags. Returns (lat, lon)."""
    extracted = None
    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            extracted = zf.extract(member, extract_dir)

        env = os.environ.copy()
        env['TMPDIR'] = extract_dir
        env['EXIFTOOL_TMP'] = extract_dir

        return read_gps_from_file(extracted, env=env)
    except Exception as exc:
        logger.warning('GPS scan failed for %s: %s', member, exc)
        return (None, None)
    finally:
        # Delete as we go so a large archive cannot fill the temp disk.
        if extracted:
            try:
                os.remove(extracted)
            except OSError:
                pass


def scan_members_parallel(zip_path, members=None):
    """Extract the given members and read their GPS tags in parallel.

    ``members=None`` scans every image member of the archive. Returns
    one record per member, keyed by its archive path:

        {'member': 'img/1.jpg', 'latitude': float|None,
         'longitude': float|None, 'has_coords': bool}

    Raises when the archive cannot be read at all or exiftool is not
    installed; individual image failures never raise.
    """
    if not shutil.which('exiftool'):
        raise RuntimeError('exiftool is not installed on the server')

    if members is None:
        members = zip_image_members(zip_path)

    logger.info(
        'Scanning %d images in %s with %d parallel workers',
        len(members), os.path.basename(zip_path), SCAN_WORKERS,
    )

    extract_dir = tempfile.mkdtemp(prefix='gps_scan_')
    try:
        with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
            gps_values = list(pool.map(
                lambda member: _scan_one(zip_path, member, extract_dir),
                members,
            ))
    finally:
        shutil.rmtree(extract_dir, ignore_errors=True)

    return [
        {
            'member': member,
            'latitude': lat,
            'longitude': lon,
            'has_coords': lat is not None and lon is not None,
        }
        for member, (lat, lon) in zip(members, gps_values)
    ]


def extract_and_scan_zip_parallel(zip_path):
    """Scan every image member; records additionally carry a 1-based
    ``name`` index for the api.py response contract."""
    rows = scan_members_parallel(zip_path)
    for idx, row in enumerate(rows, 1):
        row['name'] = idx
    return rows


def stats_from_rows(rows):
    """Aggregate per-image records into the gps_stats summary dict."""
    return {
        "total_images": len(rows),
        "with_gps": sum(1 for r in rows if r["has_coords"]),
        "without_gps": sum(1 for r in rows if not r["has_coords"]),
    }
