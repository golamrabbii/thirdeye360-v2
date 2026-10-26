"""Bounded disk cache for R2-proxied track images.

Turns the r2-proxy from a pure streaming pass-through into a write-through
cache: the first fetch of an image streams from R2 and lands on local disk;
every later request is served from disk by a plain FileResponse (fast path —
same speed as the StaticFiles track mounts, with Range/ETag support).

Design notes:
- Files mirror the R2 key layout (`<cache_dir>/track671/671_6_comp.jpg`) so
  key → path is trivial and unambiguous.
- Writes go to a temp file in the same directory and are moved into place
  with os.replace (atomic — readers never see a half-written image).
- Per-key locks prevent concurrent requests for the same key from racing;
  distinct keys never block each other.
- Eviction: oldest-atime-first until the cache fits the configured budget.
  Pruning runs periodically (every N stores) rather than per-write.
- Entirely disabled when R2_PROXY_DISK_CACHE_GB == 0 (functions become
  no-ops, so the proxy behaves exactly as before).
"""

import logging
import os
import shutil
import tempfile
import threading
import time

from config import Config

logger = logging.getLogger(__name__)

_ENABLED = Config.R2_PROXY_DISK_CACHE_GB > 0
_ROOT = Config.R2_PROXY_CACHE_DIR
_MAX_BYTES = int(Config.R2_PROXY_DISK_CACHE_GB * 1024 ** 3)
_PRUNE_EVERY = 25  # stores between full-directory prunes

_locks_guard = threading.Lock()
_key_locks = {}
_store_count = 0


def _enabled():
    return _ENABLED


def _safe_key(key):
    """Reject anything that could escape the cache root."""
    if not key or key.startswith("/") or ".." in key.split("/"):
        return None
    if not all(part for part in key.split("/")):
        return None
    return key


def _path_for(key):
    return os.path.join(_ROOT, *key.split("/"))


def _lock_for(key):
    with _locks_guard:
        lock = _key_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            # Keep the dict bounded — a few hundred concurrent keys is plenty
            if len(_key_locks) > 512:
                _key_locks.clear()
            _key_locks[key] = lock
        return lock


def cached_path(key):
    """Cache info for `key` if already cached and complete, else None.

    Returns {"path": ..., "etag": ...} — etag is the R2 ETag persisted in a
    sidecar at store time (lets the proxy answer If-None-Match without
    touching the network); etag may be None for cache entries written by an
    older version.
    """
    if not _ENABLED:
        return None
    key = _safe_key(key)
    if not key:
        return None
    path = _path_for(key)
    # os.replace makes placement atomic, so existence implies completeness
    if not os.path.isfile(path):
        return None
    etag = None
    try:
        with open(path + ".etag", "r") as f:
            etag = f.read().strip() or None
    except OSError:
        pass
    return {"path": path, "etag": etag}


def store_stream(key, chunk_iterator, etag=None):
    """Tee an R2 chunk iterator to disk; yields the same chunks unchanged.

    `etag` (the R2 ETag) is persisted to a sidecar so cache hits can answer
    If-None-Match without a network round trip. If anything fails (IO,
    disabled cache, bad key) the chunks still flow to the client — caching
    must never break serving.
    """
    global _store_count
    if not _ENABLED:
        for chunk in chunk_iterator:
            yield chunk
        return

    key = _safe_key(key)
    if not key:
        for chunk in chunk_iterator:
            yield chunk
        return

    final_path = _path_for(key)
    tmp_path = None
    try:
        os.makedirs(os.path.dirname(final_path), exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            dir=os.path.dirname(final_path), suffix=".part"
        )
        os.close(fd)
    except OSError as e:
        logger.warning(f"Disk cache unavailable for {key}: {e}")
        tmp_path = None

    ok = tmp_path is not None
    with _lock_for(key):
        try:
            for chunk in chunk_iterator:
                if ok:
                    try:
                        with open(tmp_path, "ab") as f:
                            f.write(chunk)
                    except OSError as e:
                        logger.warning(f"Disk cache write failed for {key}: {e}")
                        ok = False
                yield chunk
            if ok:
                os.replace(tmp_path, final_path)
                tmp_path = None
                if etag:
                    try:
                        with open(final_path + ".etag", "w") as f:
                            f.write(etag)
                    except OSError:
                        pass
                _store_count += 1
                if _store_count % _PRUNE_EVERY == 0:
                    prune()
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass


def prune():
    """Delete oldest-accessed files until the cache fits its budget."""
    if not _ENABLED or not os.path.isdir(_ROOT):
        return
    entries = []
    total = 0
    for dirpath, _dirnames, filenames in os.walk(_ROOT):
        for name in filenames:
            try:
                p = os.path.join(dirpath, name)
                st = os.stat(p)
                entries.append((st.st_atime, st.st_size, p))
                total += st.st_size
            except OSError:
                continue
    if total <= _MAX_BYTES:
        return

    entries.sort()  # oldest atime first
    removed = 0
    for _atime, size, p in entries:
        if total <= _MAX_BYTES:
            break
        try:
            os.remove(p)
            total -= size
            removed += 1
        except OSError:
            continue
    if removed:
        logger.info(
            f"r2 disk cache pruned {removed} files "
            f"({total / 1024 ** 3:.2f} GB kept of {_MAX_BYTES / 1024 ** 3:.0f} GB)"
        )
    # Drop empty directories left behind
    for dirpath, dirnames, filenames in os.walk(_ROOT, topdown=False):
        if not dirnames and not filenames and dirpath != _ROOT:
            try:
                os.rmdir(dirpath)
            except OSError:
                pass


def stats():
    """(files, bytes) currently in the cache — for monitoring."""
    if not _ENABLED or not os.path.isdir(_ROOT):
        return (0, 0)
    files = 0
    total = 0
    for _dirpath, _dirnames, filenames in os.walk(_ROOT):
        for name in filenames:
            try:
                total += os.stat(os.path.join(_dirpath, name)).st_size
                files += 1
            except OSError:
                continue
    return (files, total)
