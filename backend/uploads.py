"""Resumable chunked upload storage for very large ZIP files.

Accepts large ZIP files (15-20GB+) uploaded in chunks, multiple files at a
time, and simply stores the assembled file in ``<BASE_DIR>/uploads``.
No GPS extraction, no unzip, no database writes, no processing -- the final
ZIP is left in the uploads folder for the user to move manually.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import threading
import uuid
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from config import Config
from gps_scan import scan_members_parallel, stats_from_rows, zip_image_members
from zip_stream_scan import ZipStreamScanner


logger = logging.getLogger(__name__)

# ======================
# STORAGE CONFIGURATION
# ======================
UPLOADS_DIR = os.path.join(Config.BASE_DIR, 'uploads')
SESSIONS_DIR = os.path.join(UPLOADS_DIR, '.sessions')

CHUNK_SIZE = 16 * 1024 * 1024  # 16 MiB per chunk
MAX_UPLOAD_SIZE = 100 * 1024 * 1024 * 1024  # sanity cap: 100 GB
CHUNK_SLACK = 1024  # tolerated overshoot on a single chunk payload
ASSEMBLY_BLOCK = 8 * 1024 * 1024  # copy block size when assembling the final file

_PART_RE = re.compile(r'^part_(\d{6})$')
_ID_RE = re.compile(r'^[0-9a-f]{32}$')  # uuid4().hex

os.makedirs(SESSIONS_DIR, exist_ok=True)


def sanitize_filename(filename: str) -> str:
    """Sanitize a client-controlled upload filename for safe filesystem use.

    Strips directory components (both POSIX and Windows separators) so the
    name can never escape its intended directory via path traversal.
    (Same logic as api.py -- duplicated here to avoid a circular import.)
    """
    name = os.path.basename((filename or "").replace("\\", "/")).strip()
    if name in ("", ".", ".."):
        return "upload.zip"
    return name


# ======================
# MODELS
# ======================
class UploadInitRequest(BaseModel):
    filename: str
    size: int


# ======================
# UPLOAD SESSION
# ======================
class _UploadSession:
    """Bookkeeping for a single in-flight chunked upload."""

    def __init__(self, upload_id: str, filename: str, size: int,
                 chunk_size: int = CHUNK_SIZE):
        self.upload_id = upload_id
        self.filename = filename
        self.safe_filename = sanitize_filename(filename)
        self.size = size
        self.chunk_size = chunk_size
        self.created_at = datetime.now().isoformat()
        self.dir = os.path.join(SESSIONS_DIR, upload_id)
        self.meta_path = os.path.join(self.dir, 'meta.json')
        self.lock = threading.Lock()

    def part_path(self, index: int) -> str:
        return os.path.join(self.dir, f"part_{index:06d}")

    def write_meta(self) -> None:
        """Persist session metadata so it can be recovered after a restart."""
        os.makedirs(self.dir, exist_ok=True)
        meta = {
            'filename': self.filename,
            'safe_filename': self.safe_filename,
            'size': self.size,
            'chunkSize': self.chunk_size,
            'created_at': self.created_at,
        }
        tmp_path = self.meta_path + '.tmp'
        with open(tmp_path, 'w', encoding='utf-8') as fh:
            json.dump(meta, fh, indent=2)
        os.replace(tmp_path, self.meta_path)

    @classmethod
    def from_disk(cls, upload_id: str) -> Optional["_UploadSession"]:
        """Rebuild a session from its on-disk meta.json (survives restarts)."""
        meta_path = os.path.join(SESSIONS_DIR, upload_id, 'meta.json')
        if not os.path.isfile(meta_path):
            return None
        try:
            with open(meta_path, 'r', encoding='utf-8') as fh:
                meta = json.load(fh)
            session = cls(
                upload_id,
                str(meta['filename']),
                int(meta['size']),
                int(meta.get('chunkSize', CHUNK_SIZE)),
            )
            created_at = meta.get('created_at')
            if created_at:
                session.created_at = str(created_at)
            return session
        except (OSError, ValueError, KeyError, TypeError) as exc:
            logger.warning("Ignoring unreadable upload session %s: %s", upload_id, exc)
            return None

    def received_indices(self) -> List[int]:
        """Indices of the chunk part files currently on disk, sorted."""
        try:
            entries = os.listdir(self.dir)
        except OSError:
            return []
        indices = [
            int(_PART_RE.match(entry).group(1))
            for entry in entries
            if _PART_RE.match(entry)
        ]
        return sorted(indices)


# In-memory session registry; sessions are rehydrated from disk on demand
# so uploads survive a server restart (client re-inits or reuses the id).
_SESSIONS: Dict[str, _UploadSession] = {}
_REGISTRY_LOCK = threading.Lock()


def _register(session: _UploadSession) -> None:
    with _REGISTRY_LOCK:
        _SESSIONS[session.upload_id] = session


def _unregister(upload_id: str) -> None:
    with _REGISTRY_LOCK:
        _SESSIONS.pop(upload_id, None)


# Live GPS scanners keyed by upload_id (see zip_stream_scan).
_SCANNERS: Dict[str, ZipStreamScanner] = {}
_SCANNER_LOCK = threading.Lock()


def _start_scanner(session: _UploadSession) -> None:
    """Start (or reuse) the live GPS scanner for a session."""
    with _SCANNER_LOCK:
        scanner = _SCANNERS.get(session.upload_id)
        if scanner is None:
            scanner = ZipStreamScanner(
                session.upload_id, session.dir, session.chunk_size
            )
            _SCANNERS[session.upload_id] = scanner
    scanner.start()


def _pop_scanner(upload_id: str) -> Optional[ZipStreamScanner]:
    """Stop and detach the scanner of a finished/aborted upload."""
    with _SCANNER_LOCK:
        scanner = _SCANNERS.pop(upload_id, None)
    if scanner is not None:
        scanner.stop()
    return scanner


def _get_session(upload_id: str) -> Optional[_UploadSession]:
    """Return the session for upload_id, rehydrating from disk if needed."""
    if not _ID_RE.match(upload_id or ""):
        return None
    with _REGISTRY_LOCK:
        session = _SESSIONS.get(upload_id)
    if session is None:
        session = _UploadSession.from_disk(upload_id)
        if session is not None:
            _register(session)
    return session


def _find_resumable_session(safe_filename: str, size: int) -> Optional[_UploadSession]:
    """Find an existing session dir with the same filename+size so a client
    can resume a partially uploaded file after a server restart."""
    try:
        candidates = os.listdir(SESSIONS_DIR)
    except OSError:
        return None
    for upload_id in candidates:
        session = _get_session(upload_id)
        if (session is not None
                and session.safe_filename == safe_filename
                and session.size == size):
            return session
    return None


def _validate_parts(session: _UploadSession) -> Tuple[List[int], List[str]]:
    """Check that every expected part exists with exactly the right size.

    Returns (expected_indices, errors). All chunks except the last must be
    exactly chunkSize bytes; the last must make the total match the declared
    size exactly (+-0).
    """
    errors: List[str] = []
    if session.size <= 0:
        return [], ["Invalid declared size: %d" % session.size]

    expected_count = (session.size + session.chunk_size - 1) // session.chunk_size
    expected = list(range(expected_count))
    received = set(session.received_indices())

    missing = sorted(set(expected) - received)
    if missing:
        errors.append(f"Missing {len(missing)} chunk(s): {missing[:10]}")
    extra = sorted(received - set(expected))
    if extra:
        errors.append(f"Unexpected extra chunk(s): {extra[:10]}")

    total_size = 0
    for index in expected:
        part = session.part_path(index)
        if not os.path.isfile(part):
            continue
        actual = os.path.getsize(part)
        total_size += actual
        if index < expected_count - 1:
            if actual != session.chunk_size:
                errors.append(
                    f"Chunk {index} is {actual} bytes, expected {session.chunk_size}"
                )
        else:
            expected_last = session.size - (expected_count - 1) * session.chunk_size
            if actual != expected_last:
                errors.append(
                    f"Chunk {index} is {actual} bytes, expected {expected_last}"
                )

    if not errors and total_size != session.size:
        errors.append(f"Total size {total_size} does not match declared size {session.size}")
    return expected, errors


router = APIRouter()


# ======================
# ROUTES
# ======================
@router.post("/init")
async def init_upload(payload: UploadInitRequest) -> dict:
    """Create (or resume) an upload session and return the chunk size to use."""
    safe_filename = sanitize_filename(payload.filename)
    if not safe_filename.lower().endswith('.zip'):
        raise HTTPException(status_code=400, detail="Only .zip uploads are supported")
    if payload.size <= 0:
        raise HTTPException(status_code=400, detail="size must be greater than 0")
    if payload.size > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail=f"size exceeds the {MAX_UPLOAD_SIZE} byte limit")

    os.makedirs(SESSIONS_DIR, exist_ok=True)

    # Reuse an existing session for the same file so chunks already on disk
    # are not thrown away (resume across server restarts).
    existing = _find_resumable_session(safe_filename, payload.size)
    if existing is not None:
        with existing.lock:
            received = existing.received_indices()
        logger.info(
            "Resuming upload %s for %s (%d/%d chunk(s) already on disk)",
            existing.upload_id, safe_filename, len(received),
            (payload.size + existing.chunk_size - 1) // existing.chunk_size,
        )
        _start_scanner(existing)
        return {"uploadId": existing.upload_id, "chunkSize": existing.chunk_size, "received": received}

    session = _UploadSession(uuid.uuid4().hex, payload.filename, payload.size)
    session.write_meta()
    _register(session)
    _start_scanner(session)
    logger.info(
        "Created upload session %s for %s (%d bytes, chunkSize=%d)",
        session.upload_id, session.safe_filename, session.size, session.chunk_size,
    )
    return {"uploadId": session.upload_id, "chunkSize": session.chunk_size, "received": []}


@router.put("/{upload_id}/chunks/{index}")
async def upload_chunk(upload_id: str, index: int, request: Request) -> dict:
    """Store one raw chunk of the file as <session_dir>/part_{index:06d}."""
    session = _get_session(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Unknown uploadId: {upload_id}")
    if index < 0:
        raise HTTPException(status_code=400, detail="Chunk index must be >= 0")

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty chunk body")
    if len(body) > session.chunk_size + CHUNK_SLACK:
        raise HTTPException(
            status_code=413,
            detail=f"Chunk too large: {len(body)} bytes (max {session.chunk_size + CHUNK_SLACK})",
        )

    # Write to a .tmp file then rename so a partial chunk is never visible.
    part_path = session.part_path(index)
    tmp_path = part_path + '.tmp'
    try:
        with open(tmp_path, 'wb') as out:
            out.write(body)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp_path, part_path)
    except OSError as exc:
        logger.error("Failed to store chunk %d of upload %s: %s", index, upload_id, exc)
        raise HTTPException(status_code=500, detail=f"Failed to store chunk: {exc}")

    # (Re)start the live scanner if needed — covers sessions rehydrated
    # from disk after a server restart, where init may never be called.
    _start_scanner(session)

    with session.lock:
        received = session.received_indices()
    return {"received": received, "chunkSize": session.chunk_size}


@router.get("/{upload_id}/status")
async def upload_status(upload_id: str) -> dict:
    """Report which chunks are on disk so a client can resume."""
    session = _get_session(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Unknown uploadId: {upload_id}")

    with session.lock:
        received = session.received_indices()
    return {
        "uploadId": session.upload_id,
        "filename": session.filename,
        "size": session.size,
        "chunkSize": session.chunk_size,
        "received": received,
    }


@router.get("/{upload_id}/gps-stats")
async def upload_gps_stats(upload_id: str) -> dict:
    """Live GPS scan progress for an in-flight upload.

    The stream scanner extracts and scans each image as soon as its bytes
    have fully arrived, so by the time the upload reaches 100% the stats
    are (almost) already computed.
    """
    session = _get_session(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Unknown uploadId: {upload_id}")

    with _SCANNER_LOCK:
        scanner = _SCANNERS.get(upload_id)
    if scanner is not None:
        return scanner.stats()
    return {
        "total_images": 0, "with_gps": 0, "without_gps": 0,
        "scanning": 0, "deferred": False, "upload_complete": False,
    }


@router.post("/{upload_id}/complete")
async def complete_upload(upload_id: str) -> dict:
    """Assemble the stored chunks into <UPLOADS_DIR>/<filename> and clean up."""
    session = _get_session(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Unknown uploadId: {upload_id}")

    with session.lock:
        expected, errors = _validate_parts(session)
        if errors:
            raise HTTPException(status_code=400, detail="; ".join(errors))

        # Best-effort free space check before assembling.
        try:
            free_bytes = shutil.disk_usage(UPLOADS_DIR).free
            if free_bytes < session.size / 2:
                raise HTTPException(
                    status_code=507,
                    detail=f"Insufficient disk space: {free_bytes} free for a {session.size} byte file",
                )
        except OSError:
            pass  # no usable space info -- proceed

        os.makedirs(UPLOADS_DIR, exist_ok=True)
        target_path = os.path.join(UPLOADS_DIR, session.safe_filename)
        temp_path = target_path + '.part'
        try:
            with open(temp_path, 'wb') as out:
                for chunk_index in expected:
                    part_path = session.part_path(chunk_index)
                    with open(part_path, 'rb') as src:
                        shutil.copyfileobj(src, out, ASSEMBLY_BLOCK)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp_path, target_path)
        except HTTPException:
            raise
        except OSError as exc:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass
            logger.error("Failed to assemble upload %s: %s", upload_id, exc)
            raise HTTPException(status_code=500, detail=f"Failed to assemble file: {exc}")

        shutil.rmtree(session.dir, ignore_errors=True)
        _unregister(session.upload_id)

    # Stop the live scanner — everything it already scanned counts; the
    # remaining members are scanned below from the assembled file. The
    # union is always authoritative, no matter how far the stream parser
    # got while chunks were arriving.
    scanner = _pop_scanner(upload_id)
    stream_records = scanner.records() if scanner is not None else {}

    # Final scan: only the members the live scanner did not already
    # cover. Runs in a worker thread so the event loop stays free
    # (parallel uploads scan concurrently); failures surface through
    # gps_stats['error'] instead of silently reporting all-zero counts.
    try:
        all_members = zip_image_members(target_path)
        missing = [m for m in all_members if m not in stream_records]
        missing_rows = (
            await asyncio.to_thread(scan_members_parallel, target_path, missing)
            if missing else []
        )
        final = dict(stream_records)
        for row in missing_rows:
            final[row["member"]] = row
        gps_stats = stats_from_rows(list(final.values()))
    except Exception as exc:
        logger.warning("GPS scan failed for %s: %s", target_path, exc)
        gps_stats = {
            "total_images": 0, "with_gps": 0, "without_gps": 0,
            "error": str(exc) or "GPS scan failed",
        }

    logger.info(
        "Upload %s complete: %s (%d bytes) — GPS: %d/%d/%d",
        upload_id, target_path, session.size,
        gps_stats['total_images'], gps_stats['with_gps'], gps_stats['without_gps'],
    )
    return {"ok": True, "filename": session.filename, "path": target_path, "size": session.size, "gps_stats": gps_stats}


@router.delete("/{upload_id}")
async def delete_upload(upload_id: str) -> dict:
    """Discard an in-progress upload session and its stored chunks."""
    session = _get_session(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Unknown uploadId: {upload_id}")

    _pop_scanner(upload_id)

    with session.lock:
        shutil.rmtree(session.dir, ignore_errors=True)
        _unregister(session.upload_id)

    logger.info("Deleted upload session %s", upload_id)
    return {"ok": True}
