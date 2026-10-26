"""Live GPS scanning of a chunked upload while it is still in flight.

A ZIP stores every entry inline as [local file header][data], so once
enough chunks have arrived for an image's bytes to be complete, that
image can be extracted and handed to exiftool long before the upload
finishes. ``ZipStreamScanner`` watches a session's part files, walks
the local headers sequentially, and farms completed image entries out
to a thread pool. When the upload completes, ``uploads.complete_upload``
stops the scanner and scans any remainder directly from the assembled
file, so the final stats are always authoritative.

Entries that cannot be parsed mid-stream (streaming-mode zips whose
local headers carry no sizes — the "data descriptor" flag — or unknown
compression methods) are simply skipped here and picked up by the final
reconcile, so the worst case equals the old scan-at-end behaviour.
"""

import io
import logging
import os
import shutil
import tempfile
import threading
import zlib
from concurrent.futures import ThreadPoolExecutor

from gps_scan import IMAGE_EXTENSIONS, read_gps_from_file

logger = logging.getLogger(__name__)

LOCAL_HEADER_SIG = b'PK\x03\x04'

# Poll cadence while waiting for the next chunk to land.
POLL_INTERVAL = 1.5


def _is_image_member(name):
    lowered = name.lower()
    return (
        lowered.endswith(IMAGE_EXTENSIONS)
        and not name.startswith('__MACOSX')
    )


class ZipStreamScanner:
    """Incrementally scan image GPS tags in an in-flight chunked upload.

    The parts on disk (``part_000000``, ``part_000001``, ...) are treated
    as one logical byte stream. The parser only ever advances over bytes
    it has fully validated, and parts are written atomically (tmp +
    rename) by uploads.py, so a partially written chunk is never read.
    """

    def __init__(self, upload_id, parts_dir, chunk_size):
        self.upload_id = upload_id
        self.parts_dir = parts_dir
        self.chunk_size = chunk_size

        self._stop_event = threading.Event()
        self._thread = None
        self._lock = threading.Lock()

        self._offset = 0            # logical stream bytes consumed so far
        self._records = {}          # member path -> record dict (scan done)
        self._pending = 0           # submitted tasks not finished yet
        self._order = []            # member paths in stream order
        self._deferred = False      # hit entries we cannot parse mid-stream
        self._error = None          # e.g. exiftool missing
        self._tmp_dir = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def start(self):
        import shutil as _shutil
        if self._thread is not None:
            return  # already started
        if not _shutil.which('exiftool'):
            self._error = 'exiftool is not installed on the server'
            logger.warning('Scanner for %s not started: %s',
                           self.upload_id, self._error)
            return
        self._tmp_dir = tempfile.mkdtemp(prefix='zip_stream_scan_')
        self._thread = threading.Thread(
            target=self._run, name=f'zip-scan-{self.upload_id[:8]}', daemon=True
        )
        self._thread.start()
        logger.info('Live GPS scanner started for upload %s', self.upload_id)

    def stop(self):
        """Stop the background loop and wait for in-flight scans."""
        self._stop_event.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=60)
        # Let every submitted scan task finish BEFORE deleting its temp
        # files, so records() afterwards is complete and correct.
        executor = getattr(self, '_executor', None)
        if executor is not None:
            executor.shutdown(wait=True)
        if self._tmp_dir:
            shutil.rmtree(self._tmp_dir, ignore_errors=True)
            self._tmp_dir = None

    # ------------------------------------------------------------------
    # Snapshots for the API / final reconcile
    # ------------------------------------------------------------------
    def stats(self):
        with self._lock:
            done = list(self._records.values())
            pending = self._pending
            with_gps = sum(1 for r in done if r['has_coords'])
            return {
                'total_images': len(done) + pending,
                'with_gps': with_gps,
                'without_gps': len(done) - with_gps,
                'scanning': pending,
                'deferred': self._deferred,
                'upload_complete': False,
                **({'error': self._error} if self._error else {}),
            }

    def member_names(self):
        """Every image member the stream parser has seen (scanned or pending)."""
        with self._lock:
            return list(self._order)

    def records(self):
        """Completed scan records keyed by member path. Only call after
        stop() — pending tasks are resolved by then."""
        with self._lock:
            return dict(self._records)

    # ------------------------------------------------------------------
    # Background loop
    # ------------------------------------------------------------------
    def _run(self):
        try:
            while not self._stop_event.is_set():
                progressed = self._parse_available()
                if not progressed:
                    self._stop_event.wait(POLL_INTERVAL)
        except Exception as exc:  # never let the thread die silently
            logger.error('Stream scanner crashed for %s: %s', self.upload_id, exc)
        finally:
            logger.info(
                'Live GPS scanner loop ended for %s (%d members seen)',
                self.upload_id, len(self._order),
            )

    def _available_bytes(self):
        """Bytes readable from the contiguous prefix of part files."""
        total = 0
        index = 0
        while True:
            try:
                total += os.path.getsize(os.path.join(
                    self.parts_dir, f'part_{index:06d}'
                ))
            except OSError:
                break  # gap or not yet uploaded
            index += 1
        return total

    def _read_at(self, offset, length):
        """Read up to `length` bytes of the logical stream at `offset`,
        spanning part files. Returns fewer bytes when not all present."""
        chunks = []
        remaining = length
        pos = offset
        while remaining > 0:
            index, in_part = divmod(pos, self.chunk_size)
            path = os.path.join(self.parts_dir, f'part_{index:06d}')
            try:
                with open(path, 'rb') as fh:
                    fh.seek(in_part)
                    data = fh.read(min(remaining, self.chunk_size - in_part))
            except OSError:
                break  # part missing (gap) -> end of readable stream
            if not data:
                break
            chunks.append(data)
            remaining -= len(data)
            pos += len(data)
        return b''.join(chunks)

    def _parse_available(self):
        """Advance the parser over newly available bytes.

        Returns True when at least one entry (or header) was consumed,
        so the caller knows not to sleep.
        """
        with self._lock:
            offset = self._offset
        progressed = False

        while not self._stop_event.is_set():
            available = self._available_bytes()
            if offset + 30 > available:
                break  # not even a full fixed header yet

            header = self._read_at(offset, 30)
            if header[:4] != LOCAL_HEADER_SIG:
                # Central directory region or garbage: mid-stream parsing
                # is over; the final reconcile covers the rest.
                break

            flags = int.from_bytes(header[6:8], 'little')
            method = int.from_bytes(header[8:10], 'little')
            comp_size = int.from_bytes(header[18:22], 'little')
            name_len = int.from_bytes(header[26:28], 'little')
            extra_len = int.from_bytes(header[28:30], 'little')

            need = 30 + name_len + extra_len
            if offset + need > available:
                break  # header not fully on disk yet

            name_bytes = self._read_at(offset + 30, name_len)
            extra = self._read_at(offset + 30 + name_len, extra_len)
            name = name_bytes.decode('utf-8', 'replace')

            if comp_size == 0xFFFFFFFF:
                comp_size = self._zip64_comp_size(extra, header[22:26])
            if flags & 0x08 or comp_size is None:
                # Streaming-mode entry (sizes live in a trailing data
                # descriptor) or unresolvable zip64 sizes: we cannot find
                # the next header, so stop parsing mid-stream.
                self._mark_deferred(name)
                break

            data_start = offset + need
            data_end = data_start + comp_size
            if data_end > available:
                break  # entry data not fully on disk yet

            if _is_image_member(name) and comp_size > 0:
                self._submit(name, method, self._read_at(data_start, comp_size))

            offset = data_end
            progressed = True

        if progressed:
            with self._lock:
                self._offset = offset
        return progressed

    @staticmethod
    def _zip64_comp_size(extra, fallback_field):
        """Read the compressed size from a Zip64 extra field, or None."""
        uncomp_field = int.from_bytes(fallback_field, 'little')
        pos = 0
        while pos + 4 <= len(extra):
            field_id = int.from_bytes(extra[pos:pos + 2], 'little')
            field_len = int.from_bytes(extra[pos + 2:pos + 4], 'little')
            body = extra[pos + 4:pos + 4 + field_len]
            if field_id == 0x0001:
                # Local-header Zip64 extra: uncompressed size first, then
                # compressed; only the fields that were 0xFFFFFFFF appear.
                cursor = 0
                uncomp = comp = None
                if uncomp_field == 0xFFFFFFFF and cursor + 8 <= len(body):
                    uncomp = int.from_bytes(body[cursor:cursor + 8], 'little')
                    cursor += 8
                if cursor + 8 <= len(body):
                    comp = int.from_bytes(body[cursor:cursor + 8], 'little')
                return comp
            pos += 4 + field_len
        return None

    # ------------------------------------------------------------------
    # Scan task plumbing
    # ------------------------------------------------------------------
    def _submit(self, name, method, data):
        with self._lock:
            if name not in self._order:
                self._order.append(name)
            self._pending += 1
        self._pool_submit(self._scan_task, name, method, data)

    def _pool_submit(self, fn, *args):
        # A small dedicated pool keeps scanner work bounded even while
        # several uploads are in flight.
        if not hasattr(self, '_executor'):
            self._executor = ThreadPoolExecutor(
                max_workers=4, thread_name_prefix=f'zipscan-{self.upload_id[:8]}'
            )
        self._executor.submit(fn, *args)

    def _scan_task(self, name, method, data):
        path = None
        try:
            if method == 0:            # stored
                raw = data
            elif method == 8:          # deflate
                raw = zlib.decompressobj(-15).decompress(data)
            else:
                raise ValueError(f'unsupported compression method {method}')
            fd, path = tempfile.mkstemp(dir=self._tmp_dir, suffix='.img')
            with os.fdopen(fd, 'wb') as fh:
                fh.write(raw)
            lat, lon = read_gps_from_file(path)
            has_coords = lat is not None and lon is not None
            record = {
                'member': name,
                'latitude': lat,
                'longitude': lon,
                'has_coords': has_coords,
            }
        except Exception as exc:
            logger.warning('Live GPS scan failed for %s/%s: %s',
                           self.upload_id, name, exc)
            record = {
                'member': name, 'latitude': None, 'longitude': None,
                'has_coords': False,
            }
        finally:
            if path:
                try:
                    os.remove(path)
                except OSError:
                    pass

        with self._lock:
            self._records[name] = record
            self._pending -= 1

    def _mark_deferred(self, name):
        with self._lock:
            self._deferred = True
            if name and name not in self._order:
                self._order.append(name)
