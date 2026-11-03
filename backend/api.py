import subprocess
import os
import threading
import time
import re
from fastapi import Depends, FastAPI, HTTPException, Response, BackgroundTasks, Query
from fastapi.responses import FileResponse
from fastapi.responses import StreamingResponse
import psycopg2.extras
import uvicorn
from pydantic import BaseModel
from pydantic import BaseModel, validator
from typing import Dict, Any, List, Optional
import shutil
from fastapi import UploadFile, File
import tempfile
import logging
from functions import *
from fastapi.middleware.cors import CORSMiddleware
from concurrent.futures import ThreadPoolExecutor
import asyncio
from typing import Callable
import aiofiles
from typing import List
import cv2
import numpy as np
from concurrent.futures import ThreadPoolExecutor
import signal
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from threading import Event
import atexit
from datetime import datetime, timedelta, timezone
import json, httpx
import base64
import mimetypes
import requests
import os
import glob
import hashlib
import uuid
from email.utils import format_datetime
from fastapi.staticfiles import StaticFiles
import image_disk_cache

def sanitize_filename(filename: str) -> str:
    """Sanitize a client-controlled upload filename for safe filesystem use.

    Strips directory components (both POSIX and Windows separators) so the
    name can never escape its intended directory via path traversal.
    """
    name = os.path.basename((filename or "").replace("\\", "/")).strip()
    if name in ("", ".", ".."):
        return "upload.zip"
    return name

from functions import (
    _check_if_merge_needed,
    merge_all_track_geojsons,
    _last_merge_state,
    mount_all_track_folders,
    get_db_connection,
    store_unzip_images,
    create_geojson,
    store_geojson_in_db,
    calculate_smoothed_yaws,
    get_mounted_tracks,
    mount_single_track_folder,
    mount_new_track_folders,
)
from r2_service import r2_service
from config import Config
from uploads import router as uploads_router
from admin_auth import (
    require_admin,
    verify_barikoi_token,
    is_admin as check_is_admin,
    create_admin_users_table,
)
from gps_scan import extract_and_scan_zip_parallel, stats_from_rows


# TEMPORARY FILE CONFIGURATION
# Set custom temp directory
CUSTOM_TEMP_ROOT = Config.TEMP_ROOT
BASE_DIR = Config.BASE_DIR
API_BASE_URL = Config.API_BASE_URL
API_IMAGE_URL = Config.API_IMAGE_URL
os.makedirs(CUSTOM_TEMP_ROOT, exist_ok=True)
os.makedirs(CUSTOM_TEMP_ROOT, exist_ok=True)

# Force Python temp files
tempfile.tempdir = CUSTOM_TEMP_ROOT

# Set environment variables for subprocesses
os.environ.update({
    'TMPDIR': CUSTOM_TEMP_ROOT,
    'TEMP': CUSTOM_TEMP_ROOT,
    'TMP': CUSTOM_TEMP_ROOT,
    'EXIFTOOL_TMP': CUSTOM_TEMP_ROOT
})

# ======================
# LOGGING CONFIGURATION
# ======================
from logging_config import (
    setup_logging, 
    get_access_logger, 
    get_track_logger, 
    get_db_logger,
    get_upload_logger,
    log_track_operation,
    log_db_operation,
    log_upload_start,
    log_upload_complete,
    log_upload_error,
    log_processing_step
)
from middleware_logging import setup_request_logging

# Setup enhanced logging system
setup_logging(
    log_dir=os.path.join(Config.BASE_DIR, "logs"),
    log_level="INFO",
    enable_json=True,  # JSON logs for production
    enable_console=True,  # Console output for development
    max_bytes=10 * 1024 * 1024,  # 10MB per file
    backup_count=30,  # Keep 30 days of logs
    enable_request_logging=True
)

logger = logging.getLogger(__name__)
access_logger = get_access_logger()
track_logger = get_track_logger()
db_logger = get_db_logger()

# Verify configuration
logger.info(f"Temporary files will be stored in: {tempfile.gettempdir()}")

# ======================
# APPLICATION SETUP
# ======================
executor = ThreadPoolExecutor()
processing_cancelled = Event()

# Custom UploadFile class to use custom temp directory
class UploadFileWithCustomDir(UploadFile):
    def __init__(self, filename: str, file: tempfile.SpooledTemporaryFile, content_type: str = ""):
        super().__init__(filename=filename, file=file, content_type=content_type)

async def custom_upload_file(file: UploadFile = File(...)) -> UploadFileWithCustomDir:
    try:
        file_ext = os.path.splitext(file.filename)[1]
        custom_temp_path = os.path.join(CUSTOM_TEMP_ROOT, f"upload_{datetime.now().timestamp()}{file_ext}")
        async with aiofiles.open(custom_temp_path, 'wb') as out_file:
            while content := await file.read(1024 * 1024):
                await out_file.write(content)
        custom_file = open(custom_temp_path, 'rb')
        return UploadFileWithCustomDir(filename=file.filename, file=custom_file, content_type=file.content_type)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to handle custom upload: {str(e)}")

# ======================
# MODELS
# ======================
class GeoJSONFeature(BaseModel):
    feature_id: str
    longitude: float
    latitude: float
    properties: Dict[str, Any]

    @validator('properties')
    def validate_properties(cls, v):
        required_keys = {'id', 'imageUrl_high', 'imageUrl_Comp','initialYaw', 'initialPitch', 'initialHfov', 'showCompass', 'capture_date'}
        if not all(key in v for key in required_keys):
            raise ValueError("Properties must include required fields")
        return v

class Coordinates(BaseModel):
    latitude_original: float
    longitude_original: float
    latitude_snapped: float
    longitude_snapped: float

class ZipUpload(BaseModel):
    description: str = "Upload a ZIP file containing 360 images"
    

class DeleteFeaturesRequest(BaseModel):
    geojson: Dict[str, Any]  # GeoJSON geometry (Polygon or MultiPolygon)

class POIRequest(BaseModel):
    image_url: str  # Full image URL to extract POIs from
    latitude: Optional[float] = None  # Latitude for POI storage (optional)
    longitude: Optional[float] = None  # Longitude for POI storage (optional)
    feature_id: Optional[str] = None  # Feature ID for reference (optional, defaults to "direct_url")

class POIResponse(BaseModel):
    text: str
    type: str
    language: str
    location: str
    confidence: float
    target_latitude: Optional[float] = None
    target_longitude: Optional[float] = None

class POIResult(BaseModel):
    status: str
    message: str
    pois: List[POIResponse]
    feature_id: str
    processed_count: int

class RecalculateSnapRequest(BaseModel):
    track_numbers: List[str]  # List of track numbers like ["0", "1", "37"]

# ======================
# BACKGROUND JOB TRACKING
# ======================
recalculate_jobs = {}  # Track recalculation job status
upload_jobs = {}  # Track ZIP upload processing jobs


def _append_upload_job_message(job_id: str, step: str, status: str, details: str = ""):
    """Store short, recent progress messages for ZIP upload jobs."""
    job = upload_jobs.get(job_id)
    if not job:
        return

    timestamp = datetime.now().strftime("%H:%M:%S")
    message = f"{timestamp} {step} {status}"
    if details:
        message += f" ({details})"

    messages = job.setdefault("recent_messages", [])
    messages.append(message)
    if len(messages) > 25:
        del messages[:-25]


def process_upload_job(job_id: str, upload_id: str, zip_path: str, project_dir: str):
    """Background worker for ZIP processing after upload completes."""
    start_time = datetime.now()
    upload_dir = os.path.dirname(zip_path)
    temp_dir = os.path.join(project_dir, "temp_processing", job_id)
    track_folders = []

    upload_jobs[job_id].update({
        "status": "processing",
        "started_at": datetime.now().isoformat(),
        "current_step": "unzip_images",
        "total_tracks": 1,  # Show 1 initial track to indicate progress
        "processed_tracks": 0
    })
    _append_upload_job_message(job_id, "unzip_images", "started")

    try:
        os.makedirs(temp_dir, exist_ok=True)
        log_processing_step(upload_id, "unzip_images", "started")

        track_folders = store_unzip_images(
            zip_path,
            project_dir,
            temp_dir,
            1,
            processing_cancelled
        )

        if processing_cancelled.is_set():
            upload_jobs[job_id].update({
                "status": "cancelled",
                "message": "Processing cancelled by user",
                "completed_at": datetime.now().isoformat()
            })
            log_upload_error(upload_id, "Processing cancelled by user")
            _append_upload_job_message(job_id, "job", "cancelled")
            return

        if not track_folders:
            raise ValueError("Failed to process images from ZIP")

        log_processing_step(upload_id, "unzip_images", "completed", {
            "track_count": len(track_folders)
        })
        _append_upload_job_message(job_id, "unzip_images", "completed", f"tracks={len(track_folders)}")

        results = []
        total_tracks = len(track_folders)
        
        # Update with actual track count
        upload_jobs[job_id].update({
            "total_tracks": total_tracks,
            "processed_tracks": 0
        })

        for idx, track_folder in enumerate(track_folders, 1):
            if processing_cancelled.is_set():
                upload_jobs[job_id].update({
                    "status": "cancelled",
                    "message": "Processing cancelled by user",
                    "completed_at": datetime.now().isoformat()
                })
                log_upload_error(upload_id, "Processing cancelled by user")
                _append_upload_job_message(job_id, "job", "cancelled")
                return

            track_name = os.path.basename(track_folder)
            upload_jobs[job_id].update({
                "current_step": f"processing_{track_name}",
                "processed_tracks": idx - 1,
                "total_tracks": total_tracks
            })

            log_processing_step(upload_id, f"create_geojson_{track_name}", "started")
            _append_upload_job_message(job_id, f"create_geojson_{track_name}", "started")
            geojson_path = os.path.join(track_folder, "data.json")

            if not create_geojson(image_folder=track_folder, output_file=geojson_path):
                logger.error(f"Failed to create GeoJSON for {track_folder}")
                log_processing_step(upload_id, f"create_geojson_{track_name}", "failed")
                _append_upload_job_message(job_id, f"create_geojson_{track_name}", "failed")
                continue

            log_processing_step(upload_id, f"create_geojson_{track_name}", "completed")
            _append_upload_job_message(job_id, f"create_geojson_{track_name}", "completed")
            
            # Update progress after geojson creation
            upload_jobs[job_id].update({
                "current_step": f"storing_{track_name}",
            })

            log_processing_step(upload_id, f"store_db_{track_name}", "started")
            _append_upload_job_message(job_id, f"store_db_{track_name}", "started")
            if not store_geojson_in_db(geojson_path):
                logger.error(f"Failed to store data in database for {track_folder}")
                log_processing_step(upload_id, f"store_db_{track_name}", "failed")
                _append_upload_job_message(job_id, f"store_db_{track_name}", "failed")
                continue

            log_processing_step(upload_id, f"store_db_{track_name}", "completed")
            _append_upload_job_message(job_id, f"store_db_{track_name}", "completed")

            image_count = len([
                f for f in os.listdir(track_folder)
                if f.endswith('.jpg') and '_comp' not in f
            ])

            results.append({
                "track_folder": track_name,
                "geojson_url": f"/{track_name}/data.json",
                "image_count": image_count
            })

            # Update progress after track completion
            upload_jobs[job_id]["processed_tracks"] = idx

        if results and not processing_cancelled.is_set():
            upload_jobs[job_id]["current_step"] = "mount_tracks"
            log_processing_step(upload_id, "mount_tracks", "started")
            _append_upload_job_message(job_id, "mount_tracks", "started")
            mounted_count = mount_new_track_folders(app, base_dir=BASE_DIR)
            log_processing_step(upload_id, "mount_tracks", "completed", {
                "mounted_count": mounted_count
            })
            _append_upload_job_message(job_id, "mount_tracks", "completed", f"mounted={mounted_count}")

        duration_ms = (datetime.now() - start_time).total_seconds() * 1000
        total_images = sum(r['image_count'] for r in results)
        log_upload_complete(
            upload_id,
            ', '.join([r['track_folder'] for r in results]),
            total_images,
            duration_ms
        )

        upload_jobs[job_id].update({
            "status": "completed",
            "message": "Images processed and stored successfully",
            "completed_at": datetime.now().isoformat(),
            "current_step": "completed",
            "result": {
                "status": "success",
                "message": "Images processed and stored successfully",
                "tracks": results
            }
        })
        _append_upload_job_message(job_id, "job", "completed", f"tracks={len(results)}")

    except Exception as e:
        logger.error(f"Background upload job failed: {str(e)}", exc_info=True)
        log_upload_error(upload_id, str(e), e)
        upload_jobs[job_id].update({
            "status": "failed",
            "message": f"Error processing ZIP file: {str(e)}",
            "completed_at": datetime.now().isoformat(),
            "current_step": "failed"
        })
        _append_upload_job_message(job_id, "job", "failed", str(e))
    finally:
        for path in [zip_path, temp_dir]:
            if path and os.path.exists(path):
                try:
                    if os.path.isdir(path):
                        shutil.rmtree(path, ignore_errors=True)
                    else:
                        os.remove(path)
                except Exception as e:
                    logger.warning(f"Could not remove {path}: {str(e)}")

        if os.path.exists(upload_dir):
            shutil.rmtree(upload_dir, ignore_errors=True)

        if processing_cancelled.is_set() and track_folders:
            for track_folder in track_folders:
                if os.path.exists(track_folder):
                    shutil.rmtree(track_folder, ignore_errors=True)

# ======================
# FASTAPI APP
# ======================
# NOTE: no root_path — production nginx (location /api/ with a trailing-slash
# proxy_pass) strips one "/api/" before requests reach the app, so the app
# serves its declared paths ("/api/features", "/api/r2-proxy/{key}", ...) as-is.
# Public URLs keep the doubled shape: /api/api/r2-proxy/... -> app sees /api/r2-proxy/...
app = FastAPI()


@app.on_event("startup")
async def ensure_admin_users_table():
    """Ensure the admin_users permission table exists (idempotent no-op).

    Daemon thread on purpose: a blocking DB call here runs BEFORE uvicorn
    finishes booting, so a stalled connect used to leave the server bound
    but unserving (every request hung forever)."""
    threading.Thread(
        target=create_admin_users_table, daemon=True, name="admin-ddl"
    ).start()


def ensure_coverage_tables():
    """Create the district-coverage tables/indexes if missing (idempotent).

    districts + daily_track_coverage are populated by the admin refresh flow
    (see /api/coverage/refresh); the polygons themselves are maintained
    manually in the districts table (district_name + geom).
    """
    conn = get_db_connection()
    if not conn:
        logger.error("ensure_coverage_tables: no DB connection")
        return False
    cur = conn.cursor()
    try:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS districts (
                id            SERIAL PRIMARY KEY,
                district_name TEXT UNIQUE NOT NULL,
                geom          GEOGRAPHY(MultiPolygon, 4326)
            )
        """)
        cur.execute("ALTER TABLE image_features_4 ADD COLUMN IF NOT EXISTS district_name TEXT")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_if4_district_name ON image_features_4 (district_name)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_if4_capture_date ON image_features_4 (capture_date)")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS daily_track_coverage (
                id              BIGSERIAL PRIMARY KEY,
                track_number    INT NOT NULL,
                day             DATE NOT NULL,
                district_name   TEXT NOT NULL,
                distance_meters DOUBLE PRECISION NOT NULL,
                point_count     INT NOT NULL,
                first_capture   TIMESTAMPTZ,
                last_capture    TIMESTAMPTZ,
                calculated_at   TIMESTAMPTZ DEFAULT now(),
                UNIQUE (track_number, day, district_name)
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_dtc_day ON daily_track_coverage (day)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_dtc_district_day ON daily_track_coverage (district_name, day)")
        conn.commit()
        return True
    except Exception as e:
        logger.error(f"ensure_coverage_tables failed: {e}")
        conn.rollback()
        return False
    finally:
        conn.close()


@app.on_event("startup")
async def ensure_coverage_tables_startup():
    """Ensure the coverage tables exist (idempotent no-op).

    Daemon thread on purpose — see ensure_admin_users_table: startup must
    never block on the DB, or one stalled connect wedges the whole server."""
    threading.Thread(
        target=ensure_coverage_tables, daemon=True, name="coverage-ddl"
    ).start()


def _is_upload_zip_path(request: Request) -> bool:
    return request.url.path == "/api/features/upload-zip"


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # Log richer context for upload validation failures (common source of 4xx confusion).
    if _is_upload_zip_path(request):
        logger.error(
            "=== UPLOAD VALIDATION ERROR ===\n"
            f"Validation Errors: {exc.errors()}\n"
            f"Body: {exc.body}\n"
            f"Content-Type: {request.headers.get('content-type', '')}\n"
            f"Content-Length: {request.headers.get('content-length', '')}\n"
            "=============================="
        )

        # Also log to terminal for immediate visibility
        print("\n" + "=" * 60)
        print("UPLOAD VALIDATION ERROR")
        print("=" * 60)
        print(f"Validation Errors: {exc.errors()}")
        print(f"Request Body: {exc.body}")
        print(f"Content-Type: {request.headers.get('content-type', '')}")
        print("=" * 60 + "\n")

    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors()},
    )


@app.exception_handler(StarletteHTTPException)
async def starlette_http_exception_handler(request: Request, exc: StarletteHTTPException):
    # Multipart/body parsing issues may appear as HTTP 400 before endpoint code runs.
    if _is_upload_zip_path(request) and exc.status_code == 400:
        logger.warning(
            "Upload request rejected before handler: %s | content-type=%s | content-length=%s",
            exc.detail,
            request.headers.get("content-type", ""),
            request.headers.get("content-length", ""),
        )

        # Enhanced error logging for upload failures
        logger.error(
            "=== UPLOAD PARSING ERROR ===\n"
            f"Detail: {exc.detail}\n"
            f"Content-Type: {request.headers.get('content-type', '')}\n"
            f"Content-Length: {request.headers.get('content-length', '')}\n"
            f"User-Agent: {request.headers.get('user-agent', '')}\n"
            f"URL: {request.url}\n"
            f"Method: {request.method}\n"
            "=========================="
        )

    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """
    Catch-all exception handler for any unhandled exceptions.
    This is especially important for body parsing errors that occur before endpoint execution.
    """
    # Log the full exception with traceback
    logger.error(
        f"=== UNHANDLED EXCEPTION ===\n"
        f"Path: {request.url.path}\n"
        f"Method: {request.method}\n"
        f"Content-Type: {request.headers.get('content-type', '')}\n"
        f"Content-Length: {request.headers.get('content-length', '')}\n"
        f"Exception Type: {type(exc).__name__}\n"
        f"Exception Message: {str(exc)}\n"
        f"==========================",
        exc_info=True  # This includes the full traceback
    )

    # For upload requests, provide more detailed error information
    # (no request headers here — they carry the admin Authorization token)
    if _is_upload_zip_path(request):
        logger.error(
            f"=== UPLOAD EXCEPTION DETAILS ===\n"
            f"Request Path: {request.url.path}\n"
            f"Exception: {type(exc).__name__}: {str(exc)}\n"
            f"============================"
        )

        # Return user-friendly error message
        return JSONResponse(
            status_code=500,
            content={
                "detail": f"Upload processing error: {str(exc)}",
                "error_type": type(exc).__name__,
                "path": request.url.path
            }
        )

    # For non-upload requests, return generic error
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error",
            "error_type": type(exc).__name__,
            "path": request.url.path
        }
    )

# Setup request logging middleware (should be first)
setup_request_logging(app, slow_threshold_ms=2000.0)

# (Upload-request debug middleware removed 2026-11-03: it dumped every request
# header — including the admin Authorization token — to stdout and the logs on
# every upload-zip call (GitHub issue #4). middleware_logging.py already logs
# uploads with only non-sensitive fields: request id, method, endpoint, client
# IP, content-type, content-length, user-agent.)

# CORS: explicit origin whitelist for production. Set ALLOW_ALL_ORIGINS=true
# ONLY in local development - wildcard origins must never ship with credentials enabled.
if os.getenv('ALLOW_ALL_ORIGINS', 'false').lower() == 'true':
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,  # credentials cannot be combined with wildcard origins
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://maps.barikoi.com",
                       "http://103.52.143.233:8502",
                       "http://202.72.236.166:8502",
                       "https://drive.google.com",
                       "https://drive.usercontent.google.com",
                       "http://localhost:3000",
                       "http://localhost:3001",
                       "http://localhost:3457",
                       "http://localhost:4173",
                       "https://dncc.barikoimaps.dev",
                       "https://pub-a89cf2fed9d145da85124a4ad2871f95.r2.dev",
                       "https://streetview.bmapsbd.com",
                       "http://0.0.0.0:8502"
                       ],
        # Any localhost / LAN dev origin (phone testing on 192.168.x.x etc.)
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
    )

# mount_all_track_folders(app, base_dir=BASE_DIR, static_files_class=CachedStaticFiles)
mount_all_track_folders(app, base_dir=BASE_DIR)
app.include_router(uploads_router, prefix="/api/uploads")
# Also accept the single-/api form (clients using http://host:8001 as their
# base): root_path strips one /api, so mount again at /uploads.
app.include_router(uploads_router, prefix="/uploads")

# ======================
# CLEANUP HANDLING
# ======================
def cleanup_at_exit():
    processing_cancelled.set()
    temp_dirs = [
        CUSTOM_TEMP_ROOT,
        os.path.join(BASE_DIR, "tmp_uploads"),
        os.path.join(BASE_DIR, "temp_processing")
    ]
    for dir_path in temp_dirs:
        if os.path.exists(dir_path):
            shutil.rmtree(dir_path, ignore_errors=True)
            logger.info(f"Cleaned up directory: {dir_path}")

atexit.register(cleanup_at_exit)

# ======================
# DEBUG ENDPOINTS (Add these first)
# ======================
@app.get("/api/debug/capture-dates-mapping")
async def debug_capture_dates_mapping():
    """Debug endpoint to test capture dates mapping logic"""
    try:
        logger.info("Debug: Testing capture dates mapping...")
        
        # Get capture dates
        capture_dates_response = await get_capture_dates()
        logger.info(f"Debug: Capture dates response: {capture_dates_response}")
        
        # Build mapping
        capture_dates = {}
        if capture_dates_response.get('status') == 'success' and capture_dates_response.get('data'):
            for item in capture_dates_response['data']:
                track_num = item['folder_name'].replace('track', '')
                capture_dates[track_num] = item['captured_date']
        
        # Test with a sample feature ID
        test_feature_id = "0_1"
        test_track_num = test_feature_id.split('_')[0]
        
        result = {
            "capture_dates_response": capture_dates_response,
            "capture_dates_mapping": capture_dates,
            "test_feature_id": test_feature_id,
            "test_track_num": test_track_num,
            "test_capture_date": capture_dates.get(test_track_num, "Not found")
        }
        
        logger.info(f"Debug result: {result}")
        return result
        
    except Exception as e:
        logger.error(f"Debug error: {str(e)}", exc_info=True)
        return {"error": str(e), "traceback": str(e.__traceback__)}

# Universal image proxy - fetches image from database URL and returns it
@app.get("/api/drive-proxy/{feature_id}")
def image_proxy(feature_id: str, quality: str = Query("comp", description="Image quality: 'high' or 'comp'")):
    """
    Universal image proxy that works with any image source.

    Args:
        feature_id: Feature ID (e.g., "0_1", "103_414")
        quality: Image quality - "high" for high quality, "comp" for compressed (default: "comp")

    Returns:
        Image content fetched from the database URL (R2, Drive, or local)
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        # Query database for the feature
        query = """
            SELECT feature_id, image_url_high, image_url_comp, r2_key_high, r2_key_comp
            FROM image_features_4
            WHERE feature_id = %s AND is_deleted = FALSE
        """
        cursor.execute(query, (feature_id,))
        result = cursor.fetchone()

        cursor.close()
        conn.close()

        if not result:
            raise HTTPException(status_code=404, detail=f"Feature {feature_id} not found")

        db_feature_id, image_url_high, image_url_comp, r2_key_high, r2_key_comp = result

        # Determine which URL to use based on quality parameter
        if quality == "high":
            image_url = image_url_high
            r2_key = r2_key_high
        else:  # comp
            image_url = image_url_comp
            r2_key = r2_key_comp

        # If R2 key exists, stream directly from R2 (FAST)
        if r2_key is not None:
            track_num = feature_id.split('_')[0]
            if quality == "high":
                r2_path = f"track{track_num}/{feature_id}.jpg"
            else:
                r2_path = f"track{track_num}/{feature_id}_comp.jpg"

            try:
                # Stream directly from R2 (FAST - no double request)
                obj = r2_service.s3_client.get_object(
                    Bucket=Config.R2_BUCKET_NAME,
                    Key=r2_path
                )

                return StreamingResponse(
                    obj['Body'].iter_chunks(),
                    media_type="image/jpeg",
                    headers={
                        "Cache-Control": "public, max-age=86400, immutable",  # Cache for 24 hours
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                        "Access-Control-Allow-Headers": "*",
                    }
                )
            except Exception as e:
                logger.error(f"R2 streaming failed for {feature_id} ({quality}): {str(e)}")
                # Fall through to original URL if R2 streaming fails
                pass

        # For non-R2 images or R2 fallback, use original URL
        if not image_url:
            raise HTTPException(status_code=404, detail=f"No image URL found for {feature_id} ({quality})")

        # Download the image (LEGACY - for non-R2 images)
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; ThirdEye360/1.0)",
        }

        response = requests.get(image_url, headers=headers, timeout=30)

        if response.status_code != 200:
            logger.error(f"Failed to fetch image for {feature_id} ({quality}): {response.status_code}")
            raise HTTPException(
                status_code=response.status_code,
                detail=f"Failed to fetch image from source (HTTP {response.status_code})"
            )

        # Determine content type
        content_type = response.headers.get("Content-Type", "image/jpeg")

        # Return the image with appropriate headers
        return Response(
            content=response.content,
            media_type=content_type,
            headers={
                "Cache-Control": "public, max-age=86400",  # Cache for 24 hours
                "Access-Control-Allow-Origin": "*",
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in image_proxy for {feature_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@app.get("/api/r2-image/{feature_id}")
def r2_image_proxy(
    feature_id: str,
    quality: str = Query("comp", description="Image quality: 'high' or 'comp'")
):
    """
    R2-specific image proxy with proper CORS headers.
    Serves R2 images with browser-compatible headers.

    This endpoint is specifically designed for R2 images and handles:
    - Database lookup for feature
    - R2 key verification
    - Presigned URL generation
    - Image fetching with proper CORS headers
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        query = """
            SELECT feature_id, r2_key_high, r2_key_comp
            FROM image_features_4
            WHERE feature_id = %s AND is_deleted = FALSE
        """
        cursor.execute(query, (feature_id,))
        result = cursor.fetchone()

        cursor.close()
        conn.close()

        if not result:
            raise HTTPException(status_code=404, detail=f"Feature {feature_id} not found")

        db_feature_id, r2_key_high, r2_key_comp = result

        # Determine which R2 key to use based on quality
        if quality == "high":
            r2_key = r2_key_high
        else:
            r2_key = r2_key_comp

        # Check if image is migrated to R2
        if r2_key is None:
            raise HTTPException(
                status_code=404,
                detail=f"Image not migrated to R2: {feature_id} ({quality}). Use universal proxy instead."
            )

        # Generate R2 object key
        track_num = feature_id.split('_')[0]
        if quality == "high":
            r2_path = f"track{track_num}/{feature_id}.jpg"
        else:
            r2_path = f"track{track_num}/{feature_id}_comp.jpg"

        # Stream directly from R2 (FAST - no double request)
        try:
            obj = r2_service.s3_client.get_object(
                Bucket=Config.R2_BUCKET_NAME,
                Key=r2_path
            )

            return StreamingResponse(
                obj['Body'].iter_chunks(),
                media_type="image/jpeg",
                headers={
                    "Cache-Control": "public, max-age=86400, immutable",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Expose-Headers": "Content-Length, Content-Type",
                }
            )
        except Exception as e:
            logger.error(f"R2 streaming failed for {feature_id} ({quality}): {str(e)}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to stream image from R2: {str(e)}"
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in r2_image_proxy for {feature_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


# Track image keys allowed through the r2-proxy — prevents enumeration of the
# whole bucket. (_preview/_main reserved for a future image-tier pipeline.)
_R2_IMAGE_KEY_RE = re.compile(
    r'^track\d+/\d+(_\d+)*(_comp|_high|_preview|_main)?\.jpg$'
)


def _r2_proxy_headers(extra=None):
    """Common response headers for every r2-proxy response."""
    headers = {
        "Cache-Control": "public, max-age=86400, immutable",  # Cache for 24 hours
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Accept-Ranges": "bytes",
    }
    if extra:
        headers.update(extra)
    return headers


def _etag_matches(if_none_match, etag):
    """RFC 7232 If-None-Match comparison (weak tags compare equal)."""
    if not if_none_match or not etag:
        return False
    client_tags = [t.strip() for t in if_none_match.split(",")]
    return (
        etag in client_tags
        or f"W/{etag}" in client_tags
        or etag.strip('"') in {t.strip('"') for t in client_tags}
    )


def _http_date(dt):
    """HTTP-date string from a tz-aware datetime (normalized to UTC)."""
    from datetime import timezone

    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc)
    return format_datetime(dt, usegmt=True)


@app.api_route("/api/r2-proxy/{file_key:path}", methods=["GET", "HEAD"])
def r2_proxy(file_key: str, request: Request):
    """
    Direct R2 proxy - streams track images from the R2 bucket with
    correctness headers (ETag/Last-Modified/Content-Length), byte-range
    support, and an optional bounded disk cache (image_disk_cache.py): the
    first fetch streams from R2 and lands on local disk; every later hit is
    served straight from disk at StaticFiles speed.

    Usage: /api/r2-proxy/track0/0_2_comp.jpg
           /api/r2-proxy/track103/103_414.jpg

    Args:
        file_key: R2 object key (e.g., "track0/0_2_comp.jpg").
                  Restricted to track image keys; arbitrary bucket keys are rejected.

    Returns:
        FileResponse (cache hit) or StreamingResponse (R2 stream)
    """
    # Only allow legitimate track image keys - prevents enumeration of the
    # whole bucket (non-image objects, backups, other prefixes).
    if not _R2_IMAGE_KEY_RE.match(file_key):
        raise HTTPException(status_code=400, detail="Invalid image key format")

    range_header = request.headers.get("range")
    if_none_match = request.headers.get("if-none-match")

    # Disk cache hit: a plain file response gets Range handling for free,
    # and the persisted R2 ETag answers If-None-Match without the network
    cached = image_disk_cache.cached_path(file_key)
    if cached:
        hit_headers = _r2_proxy_headers(
            {"ETag": cached["etag"]} if cached.get("etag") else None
        )
        if _etag_matches(if_none_match, cached.get("etag") or ""):
            return Response(status_code=304, headers=hit_headers)
        if request.method == "HEAD":
            return Response(
                status_code=200,
                headers=_r2_proxy_headers(
                    {
                        "Content-Length": str(os.path.getsize(cached["path"])),
                        **({"ETag": cached["etag"]} if cached.get("etag") else {}),
                    }
                ),
            )
        return FileResponse(
            cached["path"], media_type="image/jpeg", headers=hit_headers
        )

    try:
        # HEAD: metadata only — never pulls the body across the network
        if request.method == "HEAD":
            head = r2_service.s3_client.head_object(
                Bucket=Config.R2_BUCKET_NAME, Key=file_key
            )
            headers = _r2_proxy_headers(
                {
                    "ETag": head.get("ETag", ""),
                    "Content-Length": str(head.get("ContentLength", 0)),
                }
            )
            if head.get("LastModified"):
                headers["Last-Modified"] = _http_date(head["LastModified"])
            return Response(status_code=200, headers=headers)

        # Conditional GET: revalidate with a cheap metadata call first, so a
        # matching client cache never re-downloads the body
        if if_none_match:
            head = r2_service.s3_client.head_object(
                Bucket=Config.R2_BUCKET_NAME, Key=file_key
            )
            etag = head.get("ETag", "")
            if _etag_matches(if_none_match, etag):
                headers = _r2_proxy_headers({"ETag": etag})
                if head.get("LastModified"):
                    headers["Last-Modified"] = _http_date(head["LastModified"])
                return Response(status_code=304, headers=headers)

        obj = r2_service.s3_client.get_object(
            Bucket=Config.R2_BUCKET_NAME,
            Key=file_key,
            **({"Range": range_header} if range_header else {}),
        )
    except r2_service.s3_client.exceptions.NoSuchKey:
        logger.error(f"R2 image not found: {file_key}")
        raise HTTPException(status_code=404, detail=f"Image not found: {file_key}")
    except Exception as e:
        logger.error(f"R2 proxy error for key {file_key}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch image from R2")

    headers = _r2_proxy_headers({"ETag": obj.get("ETag", "")})
    if obj.get("LastModified"):
        headers["Last-Modified"] = _http_date(obj["LastModified"])

    status = 200
    if range_header and obj.get("ContentRange"):
        status = 206
        headers["Content-Range"] = obj["ContentRange"]
        headers["Content-Length"] = str(obj["ContentLength"])

    # store_stream tees the body into the disk cache when enabled; with the
    # cache off it is a pass-through generator (zero behavior change).
    body = obj["Body"].iter_chunks()
    if status == 206:
        # Partial (Range) content must never enter the disk cache — caching
        # it would poison the key with a truncated "full" object that later
        # hits serve as complete.
        stream = body
    else:
        stream = image_disk_cache.store_stream(
            file_key, body, etag=obj.get("ETag", "")
        )
    return StreamingResponse(
        stream,
        status_code=status,
        media_type="image/jpeg",
        headers=headers,
    )


@app.get("/api/debug/force-merge-with-dates")
async def force_merge_with_dates():
    """Force merge and add capture dates - for debugging"""
    try:
        logger.info("Debug: Force merging with dates...")
        merged_path = os.path.join(BASE_DIR, "merged_data.json")
        
        if not os.path.exists(merged_path):
            return {"error": "Merged file doesn't exist", "path": merged_path}
            
        # Get capture dates
        capture_dates_response = await get_capture_dates()
        capture_dates = {}
        
        if capture_dates_response.get('status') == 'success' and capture_dates_response.get('data'):
            for item in capture_dates_response['data']:
                track_num = item['folder_name'].replace('track', '')
                capture_dates[track_num] = item['captured_date']
        
        logger.info(f"Debug: Found capture dates: {capture_dates}")
        
        # Load and update merged data
        with open(merged_path, 'r') as f:
            merged_data = json.load(f)
        
        updated_count = 0
        for feature in merged_data.get('features', []):
            feature_id = feature.get('properties', {}).get('id', '')
            if feature_id:
                track_num = feature_id.split('_')[0]
                capture_date = capture_dates.get(track_num, "Unknown")
                feature['properties']['capture_date'] = capture_date
                updated_count += 1
                if updated_count <= 3:  # Log first 3 for debugging
                    logger.info(f"Debug: Updated feature {feature_id} (track {track_num}) with date {capture_date}")
        
        # Save updated file
        with open(merged_path, 'w') as f:
            json.dump(merged_data, f, indent=2)
        
        logger.info(f"Debug: Updated {updated_count} features")
        
        return {
            "status": "success",
            "capture_dates_found": capture_dates,
            "features_updated": updated_count,
            "sample_feature": merged_data['features'][0] if merged_data.get('features') else None
        }
        
    except Exception as e:
        logger.error(f"Force merge error: {str(e)}", exc_info=True)
        return {"error": str(e)}

# ======================
# MAIN API ENDPOINTS
# ======================
@app.get("/health")
async def health_check():
    return {"status": "ok"}


# ======================
# ADMIN PERMISSION
# ======================
@app.get("/api/auth/permission")
async def get_admin_permission(user: dict = Depends(verify_barikoi_token)):
    """Report whether the authenticated Barikoi user has admin permission.

    Called by the frontend right after Barikoi login to decide whether to
    render the Upload 360 button and the delete controls. The upload and
    delete endpoints enforce the same check server-side via require_admin,
    so this endpoint is only a UI gate, not the security boundary.
    """
    return {
        "barikoi_id": user["barikoi_id"],
        "email": user.get("email"),
        "name": user.get("name"),
        "is_admin": check_is_admin(user["barikoi_id"]),
    }


@app.post("/api/features/cancel-processing", dependencies=[Depends(require_admin)])
async def cancel_processing(request: Request):
    processing_cancelled.set()
    active_jobs = 0
    for job in upload_jobs.values():
        if job.get("status") in {"queued", "processing"}:
            job["cancel_requested"] = True
            active_jobs += 1

    return JSONResponse(content={
        "status": "success",
        "message": "Processing cancellation requested",
        "active_jobs_flagged": active_jobs
    })



# @app.get("/api/features")
# async def get_all_features(page: int = 1, per_page: int = 10000):
#     try:
#         # Validate parameters
#         if page < 1:
#             raise HTTPException(status_code=400, detail="Page must be ≥ 1")
#         if per_page < 1 or per_page > 10000:
#             raise HTTPException(status_code=400, detail="per_page must be 1-10000")

#         conn = get_db_connection()
#         conn.set_session(isolation_level='READ COMMITTED')

        # if not conn:
#             raise HTTPException(status_code=500, detail="Database connection failed")
        
#         cursor = conn.cursor()

#         # Get total count
#         cursor.execute("SELECT COUNT(*) FROM image_features_4")
#         total = cursor.fetchone()[0]

#         # Calculate offset
#         offset = (page - 1) * per_page

#         # Get paginated data with stable ordering
#         query = """
#             SELECT * 
#             FROM image_features_4 
#             ORDER BY 
#                 CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER),
#                 CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)
#             LIMIT %s OFFSET %s
#         """
#         cursor.execute(query, (per_page, offset))
        
#         columns = [desc[0] for desc in cursor.description]
#         features = [dict(zip(columns, row)) for row in cursor.fetchall()]

#         cursor.close()
#         conn.close()

#         return {
#             "status": "success",
#             "page": page,
#             "per_page": per_page,
#             "total_items": total,
#             "total_pages": (total + per_page - 1) // per_page,
#             "data": features
#         }

#     except Exception as e:
#         logger.error(f"Error getting features: {str(e)}")
#         raise HTTPException(status_code=500, detail=str(e))

EXPORT_PATH = f"{BASE_DIR}/features.geojson"

# /api/features streams the on-disk export (features.geojson) so a call costs
# ~no CPU and never touches the DB. The export rebuild — a full-table SELECT
# plus a multi-hundred-MB file write, ~1 minute — runs ONLY in a worker thread
# when the file is missing (inline) or older than FEATURES_EXPORT_TTL_S. The
# route used to be `async def` and rebuilt inline on EVERY call, which blocked
# the event loop ~55 s per request and froze ALL endpoints — including the
# /api/r2-proxy image fetches the pano viewer's arrow steps depend on.
FEATURES_EXPORT_TTL_S = 6 * 3600
_features_export_lock = threading.Lock()


def _build_features_export():
    """Query image_features_4 and rewrite features.geojson.

    Blocking (minutes-scale) — run in a worker thread only. Returns the
    geojson dict; raises on DB/connection failure.
    """
    try:
        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")
        conn.set_session(isolation_level='READ COMMITTED')
        
        cursor = conn.cursor()

        # Two-step deduplication: Keep all images from same track, filter cross-track duplicates
        # Step 1: Partition by location+track to get newest image per location per track
        # Step 2: Among those, partition by location only to get newest across all tracks
        query = """
            SELECT
            id,
            feature_id,
            image_url_high,
            image_url_comp,
            initial_yaw,
            initial_pitch,
            initial_hfov,
            show_compass,
            longitude_original,
            latitude_original,
            longitude_snapped,
            latitude_snapped,
            capture_date,
            created_at,
            r2_key_high,
            r2_key_comp
        FROM image_features_4
        WHERE is_deleted = FALSE
        ORDER BY
            CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER),
            CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER);

        """
        cursor.execute(query)
        
        features = []
        for row in cursor.fetchall():
            capture_date = row[12]
            if capture_date:
                capture_date_display = capture_date.strftime('%B %d, %Y')
                capture_date_iso = capture_date.isoformat()
                capture_date_timestamp = capture_date.timestamp()
            else:
                capture_date_display = "Unknown"
                capture_date_iso = None
                capture_date_timestamp = None
            
            # Get original URLs from database - use as-is
            image_url_high = row[2]
            image_url_comp = row[3]

            # Use database URLs directly (no R2 presigned URL generation)
            final_url_high = image_url_high
            final_url_comp = image_url_comp

            feature = {
                "type": "Feature",
                "properties": {
                    "id": row[1],
                    # "feature_id": row[1],
                    "imageUrl_High": final_url_high,
                    "imageUrl_Comp": final_url_comp,
                    # Deprecated - for backward compatibility
                    "driveUrl_High": None,
                    "driveUrl_Comp": None,
                    "initialYaw": row[4],
                    "initialPitch": row[5],
                    "initialHfov": row[6],
                    "showCompass": row[7],
                    "longitude_snapped": row[10],
                    "latitude_snapped": row[11],
                    "capture_date": capture_date_display,
                    "capture_date_raw": capture_date_iso,
                    "capture_date_timestamp": capture_date_timestamp,
                    "previous_id": None,
                    "next_id": None
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [row[10], row[11]]
                }
            }
            features.append(feature)

        # link previous_id / next_id
        for i, feature in enumerate(features):
            if i > 0:
                feature["properties"]["previous_id"] = features[i-1]["properties"]["id"]
            if i < len(features) - 1:
                feature["properties"]["next_id"] = features[i+1]["properties"]["id"]

        cursor.close()
        conn.close()

        geojson = {
            "type": "FeatureCollection",
            "features": features
        }

        # ✅ Save to disk — compact (no indent): the file is streamed verbatim
        # by /api/features, so every byte saved is transfer saved.
        os.makedirs(os.path.dirname(EXPORT_PATH), exist_ok=True)
        # Atomic write: never truncate the live export in place. Readers
        # (FileResponse) must always see either the old or the new complete
        # file; a failed rebuild leaves the previous export untouched.
        tmp_path = f"{EXPORT_PATH}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(geojson, f, ensure_ascii=False, separators=(",", ":"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, EXPORT_PATH)
        except Exception:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            raise

        return geojson

    except Exception as e:
        logger.error(f"Error getting features: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/features")
def get_all_features():
    """All capture features as one GeoJSON FeatureCollection.

    Sync (def) on purpose: FastAPI runs it in the threadpool, so the event
    loop — and every other endpoint — stays responsive. Serves the on-disk
    export instantly; rebuilds inline only when the file is missing, and in
    a background thread when older than FEATURES_EXPORT_TTL_S (single-flight
    via the lock). Response body is the same FeatureCollection JSON as before.
    """
    try:
        if os.path.exists(EXPORT_PATH):
            age = time.time() - os.path.getmtime(EXPORT_PATH)
            if age > FEATURES_EXPORT_TTL_S and _features_export_lock.acquire(blocking=False):

                def _refresh():
                    try:
                        _build_features_export()
                        logger.info("features.geojson refreshed in background")
                    except Exception as exc:
                        logger.error(f"Background features export failed: {exc}")
                    finally:
                        _features_export_lock.release()

                threading.Thread(target=_refresh, daemon=True).start()
            return FileResponse(EXPORT_PATH, media_type="application/json")
        return JSONResponse(content=_build_features_export())
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting features: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


def check_filesystem_performance():
    """Check filesystem performance metrics"""
    try:
        disk_usage = psutil.disk_usage('.')
        disk_io = psutil.disk_io_counters()
        return {
            "disk_free_gb": disk_usage.free / (1024**3),
            "disk_percent_used": disk_usage.percent,
            "disk_read_count": disk_io.read_count,
            "disk_write_count": disk_io.write_count,
            "disk_read_mb": disk_io.read_bytes / (1024**2),
            "disk_write_mb": disk_io.write_bytes / (1024**2)
        }
    except Exception as e:
        logger.error(f"Could not check filesystem performance: {str(e)}")
        return None

@app.get("/api/debug/filesystem")
async def debug_filesystem():
    return check_filesystem_performance()


@app.get("/api/features/merge-all")
async def merge_all_tracks():
    try:
        merged_path = os.path.join(BASE_DIR, "merged_data.json")
        
        # Check if we need to re-merge
        needs_merge = _check_if_merge_needed()
        
        if not needs_merge and os.path.exists(merged_path):
            # Return cached version but still add capture dates if missing
            with open(merged_path) as f:
                cached_data = json.load(f)
            
            # Check if capture_date is already present
            if (cached_data.get('features') and 
                len(cached_data['features']) > 0 and 
                'capture_date' in cached_data['features'][0].get('properties', {})):
                logger.info("Returning cached data with capture dates")
                return JSONResponse(content=cached_data)
            else:
                # Update cached data with capture dates
                logger.info("Updating cached data with capture dates")
                needs_merge = True
        
        # Perform merge if needed
        if needs_merge:
            success = merge_all_track_geojsons()
            if not success:
                raise HTTPException(status_code=500, detail="Failed to merge track data")
        
        if os.path.exists(merged_path):
            # Load merged data and ensure capture dates are properly formatted
            with open(merged_path) as f:
                merged_data = json.load(f)
                
            # Ensure all features have capture_date property
            for feature in merged_data.get('features', []):
                props = feature.get('properties', {})
                if 'capture_date' not in props:
                    feature_id = props.get('id', '')
                    if feature_id:
                        track_num = feature_id.split('_')[0]
                        props['capture_date'] = f"Track {track_num} (Unknown)"
            
            return JSONResponse(content=merged_data)
        
        raise HTTPException(status_code=404, detail="Merged file not found after creation")
        
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Merge error: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/features/upload-zip", dependencies=[Depends(require_admin)])
async def upload_and_process_zip(
    request: Request,
    zip_file: UploadFile = File(None),
    file: UploadFile = File(None),
):
    """
    Simple ZIP upload endpoint.
    Just extracts ZIP, gets lat/lon from images, returns JSON.
    No database, no background processing, no track folders.
    """
    import tempfile
    import shutil

    upload_file = zip_file or file
    if upload_file is None:
        raise HTTPException(status_code=422, detail="Missing file. Provide form-data key 'zip_file'.")

    temp_dir = None
    results = []

    try:
        # Create temp directory
        temp_dir = tempfile.mkdtemp(dir=CUSTOM_TEMP_ROOT)

        # Save ZIP file (sanitize client-controlled filename to prevent path traversal)
        safe_filename = sanitize_filename(upload_file.filename)
        zip_temp_path = os.path.join(temp_dir, safe_filename)
        # Stream to disk in chunks - never buffer the whole file in memory
        with open(zip_temp_path, 'wb') as f:
            while chunk := await upload_file.read(1024 * 1024):
                f.write(chunk)

        zip_size = os.path.getsize(zip_temp_path)
        logger.info(f"Processing ZIP: {upload_file.filename} ({zip_size / (1024*1024):.1f}MB)")

        # Extract and process images in parallel (thread-pooled exiftool)
        rows = extract_and_scan_zip_parallel(zip_temp_path)
        results = [
            {
                "name": str(r["name"]),
                "latitude": round(r["latitude"], 6),
                "longitude": round(r["longitude"], 6),
            }
            for r in rows
            if r["has_coords"]
        ]
        gps_stats = stats_from_rows(rows)

        # Clean up the temp directory (zip + extracted images)
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)

        logger.info(
            f"Successfully extracted {len(results)} GPS coordinates from images "
            f"({gps_stats['total_images']} scanned)"
        )

        # Return simple JSON
        return JSONResponse(content={
            "data": results,
            "count": len(results),
            "gps_stats": gps_stats,
        })

    except Exception as e:
        logger.error(f"Error processing ZIP upload: {str(e)}", exc_info=True)

        # Clean up on error
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)

        raise HTTPException(status_code=500, detail=f"Error processing ZIP file: {str(e)}")


@app.get("/api/features/upload-zip/status/{job_id}")
async def get_upload_zip_job_status(job_id: str):
    job = upload_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Upload job not found")
    return job


@app.post("/api/upload", dependencies=[Depends(require_admin)])
async def upload_zip_for_map(
    zip_file: UploadFile = File(..., description="ZIP file containing images with EXIF GPS data")
):
    """
    Simple upload endpoint for lat_lon_map_app.py.

    Process:
    1. Upload ZIP file
    2. Extract to temp folder (keep it there)
    3. Extract GPS coordinates from images
    4. Return JSON with lat/lon data for plotting on map

    Returns:
    {
        "data": [
            {"name": "1", "latitude": 23.1234, "longitude": 90.5678, "status": 1},
            {"name": "2", "latitude": null, "longitude": null, "status": 0},
            ...
        ],
        "count": 10,
        "gps_count": 8,
        "no_gps_count": 2,
        "zip_path": "/tmp/uploads/zip_12345.zip"
    }
    """
    import tempfile

    temp_dir = None
    results = []
    zip_path = None

    try:
        # Create temp directory for this upload (keep it!)
        temp_upload_dir = os.path.join(CUSTOM_TEMP_ROOT, "zip_uploads")
        os.makedirs(temp_upload_dir, exist_ok=True)

        # Save ZIP file (keep it!) - sanitize client-controlled filename to prevent path traversal
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_filename = sanitize_filename(zip_file.filename)
        zip_filename = f"zip_{timestamp}_{safe_filename}"
        zip_path = os.path.join(temp_upload_dir, zip_filename)

        # Stream to disk in chunks - never buffer the whole file in memory
        with open(zip_path, 'wb') as f:
            while chunk := await zip_file.read(1024 * 1024):
                f.write(chunk)

        zip_size = os.path.getsize(zip_path)
        logger.info(f"ZIP saved to: {zip_path} ({zip_size / (1024*1024):.1f}MB)")

        # Create temp extraction directory
        temp_dir = tempfile.mkdtemp(dir=CUSTOM_TEMP_ROOT)

        # Extract and process images in parallel (thread-pooled exiftool).
        # Individual unreadable images are recorded without GPS and never
        # abort the scan.
        rows = extract_and_scan_zip_parallel(zip_path)
        results = [
            {
                "name": str(r["name"]),
                "latitude": round(r["latitude"], 6) if r["has_coords"] else None,
                "longitude": round(r["longitude"], 6) if r["has_coords"] else None,
                "status": 1 if r["has_coords"] else 0,
            }
            for r in rows
        ]

        logger.info(f"Found {len(rows)} images in ZIP")

        # Clean up extraction temp directory (but keep ZIP!)
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)

        gps_count = sum(1 for r in results if r["status"] == 1)
        no_gps_count = sum(1 for r in results if r["status"] == 0)

        logger.info(f"Successfully processed {len(results)} images: {gps_count} with GPS, {no_gps_count} without")

        # Return results
        return JSONResponse(content={
            "data": results,
            "count": len(results),
            "gps_count": gps_count,
            "no_gps_count": no_gps_count,
            "zip_path": zip_path,
            "zip_size_mb": round(zip_size / (1024 * 1024), 2)
        })

    except Exception as e:
        logger.error(f"Error processing ZIP upload: {str(e)}", exc_info=True)

        # Clean up extraction temp on error (but keep ZIP!)
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)

        raise HTTPException(status_code=500, detail=f"Error processing ZIP file: {str(e)}")


@app.get("/api/update-logs/recent")
async def get_recent_update_logs(hours: int = 24):
    """
    Get update logs from the last X hours.
    
    Parameters:
    - hours: Number of hours to look back (default: 24)
    
    Returns:
    - List of update log entries with details of coordinate changes
    """
    conn = None
    try:
        # Validate hours parameter
        if hours < 1:
            raise HTTPException(status_code=400, detail="Hours must be a positive integer")
        
        if hours > 8760:  # More than 1 year
            raise HTTPException(status_code=400, detail="Hours cannot exceed 8760 (1 year)")
        
        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")
        
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        
        # Calculate the timestamp for X hours ago
        time_threshold = datetime.now() - timedelta(hours=hours)
        
        # Query update_log table for records within the time range
        cursor.execute("""
            SELECT 
                id,
                feature_id,
                latitude_snapped_before,
                longitude_snapped_before,
                latitude_snapped_after,
                longitude_snapped_after,
                user_id,
                updated_at
            FROM update_log
            WHERE updated_at >= %s
            ORDER BY updated_at DESC
        """, (time_threshold,))
        
        logs = cursor.fetchall()
        
        # Format the results
        results = []
        for log in logs:
            results.append({
                "log_id": log["id"],
                "feature_id": log["feature_id"],
                "coordinates_before": {
                    "latitude": log["latitude_snapped_before"],
                    "longitude": log["longitude_snapped_before"]
                },
                "coordinates_after": {
                    "latitude": log["latitude_snapped_after"],
                    "longitude": log["longitude_snapped_after"]
                },
                "user_id": log["user_id"],
                "updated_at": log["updated_at"].isoformat(),
                "updated_at_timestamp": log["updated_at"].timestamp()
            })
        
        cursor.close()
        conn.close()
        
        logger.info(f"Retrieved {len(results)} update logs from last {hours} hours")
        
        return {
            "status": "success",
            "hours": hours,
            "time_range": {
                "from": time_threshold.isoformat(),
                "to": datetime.now().isoformat()
            },
            "count": len(results),
            "logs": results
        }
        
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Error fetching update logs: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()

@app.get("/api/features/all-images", response_model=dict)
async def get_all_images():
    """
    Returns the complete merged GeoJSON data containing all images from all tracks.
    Returns the JSON data directly rather than as a file download.
    """
    try:
        merged_path = os.path.join(BASE_DIR, "merged_data.json")
        
        # If merged file doesn't exist or is stale, regenerate it
        if not os.path.exists(merged_path) or _check_if_merge_needed():
            if not merge_all_track_geojsons(output_file=merged_path):
                raise HTTPException(status_code=404, detail="Merged data not available and could not be generated")
        
        # Load and return the JSON data
        with open(merged_path, 'r') as f:
            data = json.load(f)
            
        return data
        
    except HTTPException as he:
        raise he
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Invalid JSON data in merged file")
    except Exception as e:
        logger.error(f"Error serving merged data: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))





@app.get("/api/images/{image_id}")
async def get_image_data(image_id: int, comp: bool = False):
    """
    Returns the actual image data using the database ID column
    Parameters:
    - image_id: Numeric ID from database (e.g. 42)
    - compressed: If True, returns the compressed version (_comp.jpg)
    """
    try:
        # Validate ID is positive integer
        if image_id < 1:
            raise HTTPException(
                status_code=400,
                detail="ID must be a positive integer"
            )

        conn = get_db_connection()
        if not conn:
            raise HTTPException(
                status_code=500,
                detail="Database connection failed"
            )

        with conn.cursor() as cursor:
            # Get the appropriate URL and metadata
            url_type = "image_url_comp" if comp else "image_url_high"
            cursor.execute(f"""
                SELECT 
                    {url_type},
                    feature_id,
                    longitude_original,
                    latitude_original
                FROM image_features_4
                WHERE id = %s
                LIMIT 1
            """, (image_id,))
            
            result = cursor.fetchone()
            if not result:
                raise HTTPException(
                    status_code=404,
                    detail=f"Image with ID {image_id} not found"
                )

            image_url = result[0]
            feature_id = result[1]
            
            # Extract path from URL
            path_parts = image_url.split('/')
            image_path = os.path.join(path_parts[-2], path_parts[-1])
            full_path = os.path.join(BASE_DIR, image_path)
            
            if not os.path.exists(full_path):
                raise HTTPException(
                    status_code=404,
                    detail=f"Image file not found at {full_path}"
                )

            # Return the image with metadata
            return StreamingResponse(
                open(full_path, 'rb'),
                media_type="image/jpeg",
                headers={
                    "Content-Disposition": f"inline; filename={path_parts[-1]}",
                    "Cache-Control": "public, max-age=604800",
                    "X-Image-Metadata": json.dumps({
                        "id": image_id,
                        "feature_id": feature_id,
                        "coordinates": {
                            "longitude": result[2],
                            "latitude": result[3]
                        }
                    })
                }
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching image ID {image_id}: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail="Internal server error"
        )
    finally:
        if conn:
            conn.close()


@app.post("/api/features/add-track-to-db/{track_name}", dependencies=[Depends(require_admin)])
async def add_track_to_db(track_name: str):
    """
    Add a specific track folder's data to the database using path parameter
    Parameters:
    - track_name: Name of the track folder (e.g., "track0")
    """
    try:
        # Validate track name format
        if not track_name.startswith("track") or not track_name[5:].isdigit():
            raise HTTPException(
                status_code=400,
                detail="Invalid track name format. Expected format: trackN (e.g., track0)"
            )

        # Construct the path to data.json
        track_folder = os.path.join(BASE_DIR, track_name)
        geojson_path = os.path.join(track_folder, "data.json")

        # Verify the track folder and data.json exist
        if not os.path.exists(track_folder):
            raise HTTPException(
                status_code=404,
                detail=f"Track folder '{track_name}' not found"
            )

        if not os.path.exists(geojson_path):
            raise HTTPException(
                status_code=404,
                detail=f"data.json not found in track folder '{track_name}'"
            )

        # Store in database
        success = store_geojson_in_db(geojson_path)
        if not success:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to store data from {track_name} in database"
            )

        return {
            "status": "success",
            "message": f"Data from {track_name} successfully added to database",
            "track": track_name,
            "geojson_path": geojson_path
        }

    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Error adding track {track_name} to database: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {str(e)}"
        )

@app.get("/api/features/verify-track-in-db/{track_name}")
async def verify_track_in_db(track_name: str):
    """
    Check if a track's data exists in the database
    Parameters:
    - track_name: Name of the track folder (e.g., "track0")
    """
    try:
        # Validate track name format
        if not track_name.startswith("track"):
            raise HTTPException(
                status_code=400,
                detail="Track name must start with 'track'"
            )
            
        # Extract track number (everything after "track")
        track_num = track_name[5:] if len(track_name) > 5 else ""
        
        if not track_num.isdigit():
            raise HTTPException(
                status_code=400,
                detail="Track name must be in format 'trackN' where N is a number"
            )

        conn = get_db_connection()
        if not conn:
            raise HTTPException(
                status_code=500,
                detail="Database connection failed"
            )

        try:
            with conn.cursor() as cursor:
                # Count features with this exact track number (not LIKE to avoid track 21 matching track 210)
                cursor.execute(
                    "SELECT COUNT(*) FROM image_features_4 WHERE SPLIT_PART(feature_id, '_', 1) = %s",
                    (track_num,)
                )
                count = cursor.fetchone()[0]
                
                # Also get some sample features
                cursor.execute(
                    "SELECT feature_id FROM image_features_4 WHERE SPLIT_PART(feature_id, '_', 1) = %s LIMIT 5",
                    (track_num,)
                )
                sample_features = [row[0] for row in cursor.fetchall()]
                
                return {
                    "track": track_name,
                    "exists_in_db": count > 0,
                    "feature_count": count,
                    "sample_features": sample_features,
                    "db_table": "image_features_4"
                }
                
        except Exception as e:
            logger.error(f"Database query error: {str(e)}")
            raise HTTPException(
                status_code=500,
                detail=f"Database query failed: {str(e)}"
            )
            
        finally:
            if conn:
                conn.close()
                
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Unexpected error in verify-track-in-db: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {str(e)}"
        )


# @app.delete("/api/features/delete-track-from-db/{track_name}")
# async def delete_track_from_db(track_name: str):
#     """
#     Delete a track's data from database without removing physical files
#     Parameters:
#     - track_name: Name of the track folder (e.g., "track0")
#     """
#     try:
#         # Validate track name format
#         if not track_name.startswith("track") or not track_name[5:].isdigit():
#             raise HTTPException(
#                 status_code=400,
#                 detail="Invalid track name format. Expected format: trackN (e.g., track0)"
#             )

#         # Extract track number (everything after "track")
#         track_num = track_name[5:]

#         conn = get_db_connection()
#         if not conn:
#             raise HTTPException(
#                 status_code=500,
#                 detail="Database connection failed"
#             )

#         try:
#             with conn.cursor() as cursor:
#                 # Count features before deletion for reporting
#                 cursor.execute(
#                     "SELECT COUNT(*) FROM image_features_4 WHERE feature_id LIKE %s",
#                     (f"{track_num}_%",)
#                 )
#                 count_before = cursor.fetchone()[0]

#                 if count_before == 0:
#                     return {
#                         "status": "success",
#                         "message": f"No data found for {track_name} in database",
#                         "track": track_name,
#                         "deleted_count": 0
#                     }

#                 # Delete features
#                 cursor.execute(
#                     "DELETE FROM image_features_4 WHERE feature_id LIKE %s",
#                     (f"{track_num}_%",)
#                 )
#                 deleted_count = cursor.rowcount
#                 conn.commit()

#                 return {
#                     "status": "success",
#                     "message": f"Deleted {deleted_count} records for {track_name} from database",
#                     "track": track_name,
#                     "deleted_count": deleted_count
#                 }

#         except Exception as e:
#             conn.rollback()
#             logger.error(f"Database deletion error: {str(e)}")
#             raise HTTPException(
#                 status_code=500,
#                 detail=f"Database deletion failed: {str(e)}"
#             )
            
#         finally:
#             if conn:
#                 conn.close()
                
#     except HTTPException as he:
#         raise he
#     except Exception as e:
#         logger.error(f"Unexpected error in delete-track-from-db: {str(e)}")
#         raise HTTPException(
#             status_code=500,
#             detail=f"Internal server error: {str(e)}"
#         )


@app.post("/api/features/sync-tracks-with-db", dependencies=[Depends(require_admin)])
async def sync_tracks_with_db(background_tasks: BackgroundTasks):
    """
    Synchronize all track folders with database using config URLs:
    1. Find all track folders in BASE_DIR
    2. Verify each against database using internal API calls
    3. Add missing tracks to database
    Uses API_BASE_URL and API_IMAGE_URL from config
    """
    try:
        # Get base URL from config
        base_url = Config.API_BASE_URL
        if not base_url:
            raise HTTPException(
                status_code=500,
                detail="API_BASE_URL not configured"
            )

        # Find all track folders
        track_folders = sorted([
            f for f in os.listdir(Config.BASE_DIR) 
            if os.path.isdir(os.path.join(Config.BASE_DIR, f)) and 
            f.startswith("track") and 
            f[5:].isdigit()  # Ensure proper trackN format
        ])

        if not track_folders:
            return {
                "status": "success",
                "message": "No track folders found",
                "processed": 0,
                "added": 0,
                "api_base_url": base_url,
                "api_image_url": Config.API_IMAGE_URL
            }

        async def process_track(track_name: str):
            """Process individual track folder"""
            try:
                # Verify track in DB
                verify_url = f"{base_url}/api/features/verify-track-in-db/{track_name}"
                async with httpx.AsyncClient() as client:
                    verify_response = await client.get(verify_url)
                
                if verify_response.status_code != 200:
                    return {
                        "track": track_name,
                        "status": "verify_error",
                        "error": verify_response.json().get("detail", "Verification failed")
                    }

                verify_data = verify_response.json()
                
                # Skip if already exists
                if verify_data.get("exists_in_db", False):
                    return {
                        "track": track_name,
                        "status": "exists",
                        "feature_count": verify_data.get("feature_count", 0)
                    }

                # Add missing track
                add_url = f"{base_url}/api/features/add-track-to-db/{track_name}"
                async with httpx.AsyncClient() as client:
                    add_response = await client.post(add_url)
                
                if add_response.status_code == 200:
                    return {
                        "track": track_name,
                        "status": "added",
                        "features_added": add_response.json().get("feature_count", 0)
                    }
                else:
                    return {
                        "track": track_name,
                        "status": "add_error",
                        "error": add_response.json().get("detail", "Addition failed")
                    }

            except Exception as e:
                return {
                    "track": track_name,
                    "status": "error",
                    "error": str(e)
                }

        # Process all tracks concurrently
        results = await asyncio.gather(*[process_track(track) for track in track_folders])
        added_count = sum(1 for r in results if r.get("status") == "added")

        # Generate summary
        response = {
            "status": "success",
            "message": f"Synchronized {len(track_folders)} track folders",
            "processed": len(track_folders),
            "added": added_count,
            "api_base_url": base_url,
            "api_image_url": Config.API_IMAGE_URL,
            "results": results
        }

        # Optionally trigger merge after sync
        if added_count > 0:
            background_tasks.add_task(
                requests.post,
                f"{base_url}/api/features/merge-all"
            )

        return response

    except Exception as e:
        logger.error(f"Sync error: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Synchronization failed: {str(e)}"
        )
# @app.get("/tiles/{z}/{x}/{y}.pbf")
# async def get_vector_tile(z: int, x: int, y: int):
#     tile_path = os.path.join("./third-eye-360/tiles", f"{z}/{x}/{y}.pbf")
#     if os.path.exists(tile_path):
#         return FileResponse(tile_path, media_type="application/x-protobuf")
#     return Response(status_code=404)


# @app.get("/tiles/{z}/{x}/{y}.pbf")
# async def get_vector_tile(z: int, x: int, y: int):
#     tile_path = os.path.join("./third-eye-360/tiles", f"{z}/{x}/{y}.pbf")
    
#     if os.path.exists(tile_path):
#         return FileResponse(tile_path, media_type="application/x-protobuf")
    
#     # Return empty tile if not found
#     empty_tile = mapbox_vector_tile.encode({
#         'features': [],
#         'type': 'FeatureCollection'
#     })
#     return Response(content=empty_tile, media_type="application/x-protobuf")
@app.get("/api/features/distance/{track_name}")
async def get_track_distance(track_name: str):
    """Get distance covered by a specific track"""
    try:
        # Extract track number from track_name (e.g., "track0" -> "0")
        if not track_name.startswith('track'):
            raise HTTPException(status_code=400, detail="Track name must start with 'track'")
        
        track_num = track_name.replace('track', '')
        
        # Validate track exists
        conn = get_db_connection()
        cursor = conn.cursor()
        # Use exact match to avoid track 21 matching track 210
        cursor.execute("SELECT COUNT(*) FROM image_features_4 WHERE SPLIT_PART(feature_id, '_', 1) = %s", (track_num,))
        count = cursor.fetchone()[0]
        
        if count == 0:
            raise HTTPException(status_code=404, detail=f"Track {track_name} not found")
        
        # Calculate distance
        total_meters = calculate_track_distance(track_name)
        
        # Get additional info
        cursor.execute("""
            SELECT COUNT(*), 
                   MIN(created_at), 
                   MAX(created_at)
            FROM image_features_4 
            WHERE SPLIT_PART(feature_id, '_', 1) = %s
        """, (track_num,))
        
        point_count, min_date, max_date = cursor.fetchone()
        
        return {
            "track_name": track_name,
            "total_distance_meters": round(total_meters, 2),
            "total_distance_kilometers": round(total_meters / 1000, 2),
            "point_count": point_count,
            "date_range": [min_date.isoformat() if min_date else None, 
                          max_date.isoformat() if max_date else None]
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting distance for {track_name}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/features/distance-all")
async def get_all_tracks_distance():
    """Get distance covered by all tracks"""
    try:
        track_names = get_all_track_names()
        results = []
        total_all_meters = 0.0
        
        for track_name in track_names:
            distance_meters = calculate_track_distance(track_name)
            total_all_meters += distance_meters
            
            # Get point count for this track
            track_num = track_name.replace('track', '')
            conn = get_db_connection()
            cursor = conn.cursor()
            # Use exact match to avoid track 21 matching track 210
            cursor.execute("SELECT COUNT(*) FROM image_features_4 WHERE SPLIT_PART(feature_id, '_', 1) = %s", (track_num,))
            point_count = cursor.fetchone()[0]
            
            results.append({
                "track_name": track_name,
                "distance_meters": round(distance_meters, 2),
                "distance_kilometers": round(distance_meters / 1000, 2),
                "point_count": point_count
            })
        
        return {
            "tracks": results,
            "total_all_tracks_meters": round(total_all_meters, 2),
            "total_all_tracks_kilometers": round(total_all_meters / 1000, 2),
            "track_count": len(results)
        }
        
    except Exception as e:
        logger.error(f"Error getting all tracks distance: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/coverage")
async def get_coverage_stats(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    force_recalculate: bool = False,
    calculate_if_missing: bool = False
):
    """
    Get distance coverage statistics for all tracks with optional date filtering.
    Results are cached in database to avoid recalculation.
    
    Parameters:
    - start_date: Optional start date filter (YYYY-MM-DD format)
    - end_date: Optional end date filter (YYYY-MM-DD format)
    - force_recalculate: Force recalculation even if cached data exists (slow for 200k images)
    - calculate_if_missing: Calculate missing tracks in background (default: false, just return cached)
    
    Returns:
    - Total coverage across all tracks
    - Per-track breakdown with distance in meters/kilometers
    - Date range information
    """
    try:
        from datetime import datetime
        
        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")
        
        cursor = conn.cursor()
        
        # Create cache table if it doesn't exist
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS track_coverage_cache (
                id SERIAL PRIMARY KEY,
                track_number TEXT NOT NULL,
                date_filter_start DATE,
                date_filter_end DATE,
                distance_meters DOUBLE PRECISION NOT NULL,
                point_count INTEGER NOT NULL,
                first_capture_date TIMESTAMP,
                last_capture_date TIMESTAMP,
                calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(track_number, date_filter_start, date_filter_end)
            )
        """)
        conn.commit()
        
        # Parse date filters
        date_filter_start = None
        date_filter_end = None
        
        if start_date:
            try:
                date_filter_start = datetime.strptime(start_date, '%Y-%m-%d').date()
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid start_date format. Use YYYY-MM-DD")
        
        if end_date:
            try:
                date_filter_end = datetime.strptime(end_date, '%Y-%m-%d').date()
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid end_date format. Use YYYY-MM-DD")
        
        # Get all unique track numbers (fast query, no data loading)
        cursor.execute("""
            SELECT SPLIT_PART(feature_id, '_', 1) as track_num 
            FROM image_features_4 
            GROUP BY SPLIT_PART(feature_id, '_', 1)
            ORDER BY CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER)
        """)
        track_numbers = [row[0] for row in cursor.fetchall()]
        
        results = []
        total_distance_meters = 0.0
        total_points = 0
        cached_count = 0
        missing_count = 0
        
        for track_num in track_numbers:
            # ALWAYS check cache first
            cursor.execute("""
                SELECT distance_meters, point_count, first_capture_date, last_capture_date, calculated_at
                FROM track_coverage_cache
                WHERE track_number = %s 
                AND date_filter_start IS NOT DISTINCT FROM %s
                AND date_filter_end IS NOT DISTINCT FROM %s
            """, (track_num, date_filter_start, date_filter_end))
            cached_data = cursor.fetchone()
            
            if cached_data and not force_recalculate:
                # Use cached data
                distance_meters, point_count, first_date, last_date, calculated_at = cached_data
                cached_count += 1
                
                results.append({
                    "track_name": f"track{track_num}",
                    "track_number": track_num,
                    "distance_meters": round(distance_meters, 2),
                    "distance_kilometers": round(distance_meters / 1000, 2),
                    "point_count": point_count,
                    "first_capture_date": first_date.isoformat() if first_date else None,
                    "last_capture_date": last_date.isoformat() if last_date else None,
                    "cached": True
                })
                
                total_distance_meters += distance_meters
                total_points += point_count
            else:
                # Missing cache entry
                missing_count += 1
                
                if calculate_if_missing or force_recalculate:
                    # Calculate now (WARNING: slow for large tracks)
                    logger.warning(f"Calculating distance for track{track_num} with {point_count} points - this may be slow")
                    # ... calculation logic would go here but we skip it for speed
                    # Instead, return a placeholder
                    results.append({
                        "track_name": f"track{track_num}",
                        "track_number": track_num,
                        "status": "calculating",
                        "message": "Use /api/coverage/calculate/{track_number} to calculate"
                    })
                else:
                    # Return placeholder for missing data
                    results.append({
                        "track_name": f"track{track_num}",
                        "track_number": track_num,
                        "status": "not_calculated",
                        "message": "Use /api/coverage/calculate/{track_number} to calculate",
                        "cached": False
                    })
        
        cursor.close()
        conn.close()
        
        return {
            "status": "success",
            "filters": {
                "start_date": start_date,
                "end_date": end_date
            },
            "summary": {
                "total_distance_meters": round(total_distance_meters, 2),
                "total_distance_kilometers": round(total_distance_meters / 1000, 2),
                "total_points": total_points,
                "track_count": len(track_numbers),
                "cached_tracks": cached_count,
                "missing_cache": missing_count
            },
            "tracks": results,
            "note": "For missing tracks, use /api/coverage/calculate-all or /api/coverage/calculate/{track_number}"
        }
        
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Error getting coverage stats: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/coverage/calculate/{track_number}", dependencies=[Depends(require_admin)])
async def calculate_track_coverage(
    track_number: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
):
    """
    Calculate distance coverage for a SINGLE track and cache it.
    Use this to calculate tracks one-by-one instead of all at once.

    Admin permission required.
    Parameters:
    - track_number: Track number to calculate (e.g., "1", "37")
    - start_date: Optional start date filter (YYYY-MM-DD format)
    - end_date: Optional end date filter (YYYY-MM-DD format)
    """
    return await asyncio.to_thread(
        _calculate_track_coverage_impl, track_number, start_date, end_date
    )


def _calculate_track_coverage_impl(
    track_number: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
):
    """Sync core of calculate_track_coverage — shared by the endpoint and the
    calculate-all background fan-out (in-process threadpool, no loopback HTTP)."""
    try:
        from geopy.distance import geodesic
        from datetime import datetime
        
        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")
        
        cursor = conn.cursor()
        
        # Parse date filters
        date_filter_start = None
        date_filter_end = None
        
        if start_date:
            try:
                date_filter_start = datetime.strptime(start_date, '%Y-%m-%d').date()
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid start_date format. Use YYYY-MM-DD")
        
        if end_date:
            try:
                date_filter_end = datetime.strptime(end_date, '%Y-%m-%d').date()
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid end_date format. Use YYYY-MM-DD")
        
        # Build query with date filters
        # IMPORTANT: Use exact track number match to avoid matching track 21 with track 210
        where_clause = "SPLIT_PART(feature_id, '_', 1) = %s"
        params = [track_number]
        
        if date_filter_start:
            where_clause += " AND DATE(capture_date) >= %s"
            params.append(date_filter_start)
        
        if date_filter_end:
            where_clause += " AND DATE(capture_date) <= %s"
            params.append(date_filter_end)
        
        # Get all points for the track in sequence order
        query = f"""
            SELECT 
                latitude_snapped, 
                longitude_snapped,
                capture_date
            FROM image_features_4 
            WHERE {where_clause}
            ORDER BY CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)
        """
        
        logger.info(f"Calculating distance for track{track_number}...")
        cursor.execute(query, params)
        points = cursor.fetchall()
        
        point_count = len(points)
        
        if point_count == 0:
            raise HTTPException(status_code=404, detail=f"Track {track_number} not found")
        
        if point_count < 2:
            distance_meters = 0.0
            first_date = None
            last_date = None
        else:
            # Calculate distance between consecutive points
            distance_meters = 0.0
            for i in range(len(points) - 1):
                lat1, lon1, _ = points[i]
                lat2, lon2, _ = points[i+1]
                if lat1 and lon1 and lat2 and lon2:
                    distance_meters += geodesic((lat1, lon1), (lat2, lon2)).meters
            
            first_date = points[0][2]
            last_date = points[-1][2]
        
        # Cache the result
        cursor.execute("""
            INSERT INTO track_coverage_cache 
            (track_number, date_filter_start, date_filter_end, distance_meters, 
             point_count, first_capture_date, last_capture_date)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (track_number, date_filter_start, date_filter_end)
            DO UPDATE SET
                distance_meters = EXCLUDED.distance_meters,
                point_count = EXCLUDED.point_count,
                first_capture_date = EXCLUDED.first_capture_date,
                last_capture_date = EXCLUDED.last_capture_date,
                calculated_at = CURRENT_TIMESTAMP
        """, (track_number, date_filter_start, date_filter_end, distance_meters, 
              point_count, first_date, last_date))
        conn.commit()
        
        cursor.close()
        conn.close()
        
        logger.info(f"Calculated and cached distance for track{track_number}: {distance_meters:.2f}m")
        
        return {
            "status": "success",
            "track_number": track_number,
            "distance_meters": round(distance_meters, 2),
            "distance_kilometers": round(distance_meters / 1000, 2),
            "point_count": point_count,
            "first_capture_date": first_date.isoformat() if first_date else None,
            "last_capture_date": last_date.isoformat() if last_date else None,
            "cached": True
        }
        
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Error calculating coverage for track {track_number}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/coverage/calculate-all", dependencies=[Depends(require_admin)])
async def calculate_all_tracks_coverage(
    background_tasks: BackgroundTasks,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    batch_size: int = 5
):
    """
    Calculate distance coverage for ALL tracks in background (async).
    This processes tracks in batches to avoid timeouts.
    
    Parameters:
    - start_date: Optional start date filter (YYYY-MM-DD format)
    - end_date: Optional end date filter (YYYY-MM-DD format)
    - batch_size: Number of tracks to process concurrently (default: 5)
    
    Returns immediately with status, actual calculation happens in background.
    """
    try:
        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")
        
        cursor = conn.cursor()
        
        # Get all unique track numbers
        cursor.execute("""
            SELECT SPLIT_PART(feature_id, '_', 1) as track_num 
            FROM image_features_4 
            GROUP BY SPLIT_PART(feature_id, '_', 1)
            ORDER BY CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER)
        """)
        track_numbers = [row[0] for row in cursor.fetchall()]
        
        cursor.close()
        conn.close()
        
        # Add background task to calculate all tracks
        async def calculate_all_in_background():
            logger.info(f"Starting background calculation for {len(track_numbers)} tracks...")
            
            # Process in batches
            for i in range(0, len(track_numbers), batch_size):
                batch = track_numbers[i:i+batch_size]
                logger.info(f"Processing batch {i//batch_size + 1}: tracks {batch}")
                
                # Calculate each track in the batch concurrently, in-process
                # (threadpool). The old loopback-HTTP fan-out cannot carry the
                # admin gate on the single-track endpoint.
                tasks = [
                    asyncio.to_thread(
                        _calculate_track_coverage_impl, track_num, start_date, end_date
                    )
                    for track_num in batch
                ]

                results = await asyncio.gather(*tasks, return_exceptions=True)

                for track_num, result in zip(batch, results):
                    if isinstance(result, Exception):
                        logger.error(f"Failed to calculate track{track_num}: {result}")
                    else:
                        logger.info(f"Calculated track{track_num}")
            
            logger.info("Background calculation completed!")
        
        # Add to background tasks
        background_tasks.add_task(calculate_all_in_background)
        
        return {
            "status": "started",
            "message": f"Calculating coverage for {len(track_numbers)} tracks in background",
            "track_count": len(track_numbers),
            "batch_size": batch_size,
            "estimated_batches": (len(track_numbers) + batch_size - 1) // batch_size,
            "note": "Check /api/coverage to see progress. Calculation happens in background."
        }
        
    except Exception as e:
        logger.error(f"Error starting background calculation: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/coverage/clear-cache", dependencies=[Depends(require_admin)])
async def clear_coverage_cache(track_number: Optional[str] = None):
    """
    Clear the coverage calculation cache.
    
    Parameters:
    - track_number: Optional specific track number to clear (e.g., "0", "37"). If not provided, clears all cache.
    """
    try:
        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")
        
        cursor = conn.cursor()
        
        if track_number:
            # Clear cache for specific track
            cursor.execute("""
                DELETE FROM track_coverage_cache WHERE track_number = %s
            """, (track_number,))
            deleted_count = cursor.rowcount
            message = f"Cleared cache for track{track_number}"
        else:
            # Clear all cache
            cursor.execute("DELETE FROM track_coverage_cache")
            deleted_count = cursor.rowcount
            message = "Cleared all coverage cache"
        
        conn.commit()
        cursor.close()
        conn.close()
        
        return {
            "status": "success",
            "message": message,
            "deleted_count": deleted_count
        }
        
    except Exception as e:
        logger.error(f"Error clearing coverage cache: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/coverage/debug/{track_number}")
async def debug_track_coverage(track_number: str, limit: int = 20):
    """
    Debug endpoint to inspect track coordinates and distances between consecutive points.
    Shows the largest jumps that might indicate GPS errors.
    
    Parameters:
    - track_number: Track number to debug (e.g., "1", "37")
    - limit: Number of largest jumps to show (default: 20)
    """
    try:
        from geopy.distance import geodesic
        
        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")
        
        cursor = conn.cursor()
        
        # Get all points for the track in sequence order
        # IMPORTANT: Use exact track number match to avoid matching track 21 with track 210
        query = """
            SELECT 
                feature_id,
                latitude_snapped, 
                longitude_snapped,
                capture_date,
                latitude_original,
                longitude_original
            FROM image_features_4 
            WHERE SPLIT_PART(feature_id, '_', 1) = %s
            ORDER BY CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)
        """
        
        cursor.execute(query, (track_number,))
        points = cursor.fetchall()
        
        if len(points) < 2:
            return {
                "error": "Track has fewer than 2 points",
                "point_count": len(points)
            }
        
        # Calculate distances between consecutive points
        jumps = []
        total_distance = 0.0
        
        for i in range(len(points) - 1):
            feature_id_1, lat1, lon1, date1, lat1_orig, lon1_orig = points[i]
            feature_id_2, lat2, lon2, date2, lat2_orig, lon2_orig = points[i+1]
            
            if lat1 and lon1 and lat2 and lon2:
                distance = geodesic((lat1, lon1), (lat2, lon2)).meters
                total_distance += distance
                
                # Calculate time difference if dates available
                time_diff_seconds = None
                speed_kmh = None
                if date1 and date2:
                    time_diff_seconds = (date2 - date1).total_seconds()
                    if time_diff_seconds > 0:
                        speed_kmh = (distance / 1000) / (time_diff_seconds / 3600)
                
                jumps.append({
                    "from_feature": feature_id_1,
                    "to_feature": feature_id_2,
                    "distance_meters": round(distance, 2),
                    "distance_km": round(distance / 1000, 2),
                    "from_coords_snapped": [lat1, lon1],
                    "to_coords_snapped": [lat2, lon2],
                    "from_coords_original": [lat1_orig, lon1_orig],
                    "to_coords_original": [lat2_orig, lon2_orig],
                    "time_diff_seconds": time_diff_seconds,
                    "speed_kmh": round(speed_kmh, 2) if speed_kmh else None,
                    "from_time": date1.isoformat() if date1 else None,
                    "to_time": date2.isoformat() if date2 else None
                })
        
        # Sort by distance (largest jumps first)
        jumps_sorted = sorted(jumps, key=lambda x: x["distance_meters"], reverse=True)
        
        # Get statistics
        distances = [j["distance_meters"] for j in jumps]
        avg_distance = sum(distances) / len(distances)
        max_distance = max(distances)
        min_distance = min(distances)
        
        # Find suspicious jumps (> 1km or speed > 100 km/h)
        suspicious_jumps = [
            j for j in jumps 
            if j["distance_meters"] > 1000 or (j["speed_kmh"] and j["speed_kmh"] > 100)
        ]
        
        cursor.close()
        conn.close()
        
        return {
            "track_number": track_number,
            "total_points": len(points),
            "total_distance_meters": round(total_distance, 2),
            "total_distance_km": round(total_distance / 1000, 2),
            "statistics": {
                "average_jump_meters": round(avg_distance, 2),
                "max_jump_meters": round(max_distance, 2),
                "min_jump_meters": round(min_distance, 2),
                "suspicious_jumps_count": len(suspicious_jumps)
            },
            "largest_jumps": jumps_sorted[:limit],
            "suspicious_jumps": suspicious_jumps[:limit],
            "first_point": {
                "feature_id": points[0][0],
                "coords_snapped": [points[0][1], points[0][2]],
                "coords_original": [points[0][4], points[0][5]],
                "time": points[0][3].isoformat() if points[0][3] else None
            },
            "last_point": {
                "feature_id": points[-1][0],
                "coords_snapped": [points[-1][1], points[-1][2]],
                "coords_original": [points[-1][4], points[-1][5]],
                "time": points[-1][3].isoformat() if points[-1][3] else None
            }
        }
        
    except Exception as e:
        logger.error(f"Error debugging track coverage: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

# ======================
# DISTRICT / DAILY COVERAGE (analytics)
# ======================
class CoverageRefreshRequest(BaseModel):
    start_date: Optional[str] = None  # YYYY-MM-DD, default: yesterday (Asia/Dhaka)
    end_date: Optional[str] = None    # YYYY-MM-DD, default: today (Asia/Dhaka)


DHAKA_TZ = timezone(timedelta(hours=6))  # Asia/Dhaka (UTC+6, no DST)


@app.post("/api/coverage/refresh", dependencies=[Depends(require_admin)])
async def refresh_daily_coverage(body: CoverageRefreshRequest = None):
    """Recompute daily_track_coverage for a date range (admin only).

    Default range: yesterday + today in Asia/Dhaka local dates. Also assigns
    district_name (point-in-polygon) to any capture rows that don't have one
    yet — new rows from the upload pipeline get theirs on the next refresh.
    """
    from datetime import datetime as dt

    ensure_coverage_tables()

    body = body or CoverageRefreshRequest()
    today = dt.now(DHAKA_TZ).date()
    try:
        end_d = dt.strptime(body.end_date, "%Y-%m-%d").date() if body.end_date else today
        start_d = (
            dt.strptime(body.start_date, "%Y-%m-%d").date()
            if body.start_date
            else today - timedelta(days=1)
        )
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")
    if start_d > end_d:
        start_d, end_d = end_d, start_d

    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
    cur = conn.cursor()
    try:
        # 1. Point-in-polygon: name any rows that don't have a district yet.
        #    A point's district never changes, so only NULL rows are touched.
        cur.execute(
            """
            UPDATE image_features_4 f
            SET district_name = d.district_name
            FROM districts d
            WHERE f.district_name IS NULL
              AND f.geom IS NOT NULL
              AND ST_Covers(d.geom::geometry, f.geom)
            """
        )
        assigned = cur.rowcount

        # 2. Drop the range and 3. recompute it set-based (window functions
        #    replace the per-track Python loop). A segment counts toward the
        #    day of its start point; cross-midnight segments are skipped.
        cur.execute(
            "DELETE FROM daily_track_coverage WHERE day BETWEEN %s AND %s",
            (start_d, end_d),
        )
        cur.execute(
            """
            WITH pts AS (
                SELECT track_number, district_name,
                       (capture_date AT TIME ZONE 'Asia/Dhaka')::date AS day,
                       geom, capture_date,
                       LAG(geom) OVER w AS prev_geom,
                       LAG((capture_date AT TIME ZONE 'Asia/Dhaka')::date) OVER w AS prev_day
                FROM image_features_4
                WHERE is_deleted IS NOT TRUE
                  AND geom IS NOT NULL
                  AND district_name IS NOT NULL
                  AND capture_date IS NOT NULL
                  AND track_number IS NOT NULL
                WINDOW w AS (PARTITION BY track_number ORDER BY capture_date, id)
            )
            SELECT day, district_name, track_number,
                   COALESCE(SUM(ST_Distance(geom::geography, prev_geom::geography))
                            FILTER (WHERE prev_day = day), 0) AS distance_meters,
                   COUNT(*) AS point_count,
                   MIN(capture_date) AS first_capture,
                   MAX(capture_date) AS last_capture
            FROM pts
            WHERE day BETWEEN %s AND %s
            GROUP BY day, district_name, track_number
            """,
            (start_d, end_d),
        )
        rows = cur.fetchall()
        for day, district_name, track_number, meters, count, first_c, last_c in rows:
            cur.execute(
                """
                INSERT INTO daily_track_coverage
                    (track_number, day, district_name, distance_meters,
                     point_count, first_capture, last_capture)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (track_number, day, district_name) DO UPDATE SET
                    distance_meters = EXCLUDED.distance_meters,
                    point_count = EXCLUDED.point_count,
                    first_capture = EXCLUDED.first_capture,
                    last_capture = EXCLUDED.last_capture,
                    calculated_at = now()
                """,
                (track_number, day, district_name, float(meters), count, first_c, last_c),
            )
        conn.commit()
        logger.info(
            f"Coverage refresh {start_d}..{end_d}: {len(rows)} track-day rows, "
            f"{assigned} rows newly assigned to a district"
        )
        return {
            "status": "success",
            "start_date": start_d.isoformat(),
            "end_date": end_d.isoformat(),
            "rows_computed": len(rows),
            "rows_assigned_to_district": assigned,
        }
    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        logger.error(f"Coverage refresh failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        cur.close()
        conn.close()


@app.get("/api/coverage/districts")
async def get_district_coverage(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
):
    """District-wise coverage totals from the daily rollup (fast read)."""
    from datetime import datetime as dt

    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
    cur = conn.cursor()
    try:
        params = []
        where = ""
        if start_date and end_date:
            start_d = dt.strptime(start_date, "%Y-%m-%d").date()
            end_d = dt.strptime(end_date, "%Y-%m-%d").date()
            where = "WHERE t.day BETWEEN %s AND %s"
            params = [start_d, end_d]
        cur.execute(
            f"""
            SELECT COALESCE(t.district_name, 'Unassigned') AS district_name,
                   COALESCE(SUM(t.distance_meters), 0)     AS distance_meters,
                   COALESCE(SUM(t.point_count), 0)         AS point_count,
                   COUNT(DISTINCT t.day)                   AS active_days,
                   COUNT(DISTINCT t.track_number)          AS tracks
            FROM daily_track_coverage t
            {where}
            GROUP BY 1
            ORDER BY 2 DESC
            """,
            params,
        )
        rows = cur.fetchall()
        return {
            "status": "success",
            "districts": [
                {
                    "district_name": r[0],
                    "distance_meters": round(float(r[1]), 2),
                    "point_count": int(r[2]),
                    "active_days": int(r[3]),
                    "track_count": int(r[4]),
                }
                for r in rows
            ]
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"District coverage read failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        cur.close()
        conn.close()


@app.get("/api/coverage/daily")
def get_daily_coverage(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
):
    """Per-day coverage totals (all districts). Default window: the most
    recent 7 days that have data (ends at the newest day in the rollup, or
    today when the rollup is empty). Missing days come back as 0 so charts
    get a continuous series."""
    from datetime import datetime as dt

    tz = DHAKA_TZ
    today = dt.now(tz).date()
    try:
        end_d = dt.strptime(end_date, "%Y-%m-%d").date() if end_date else None
        start_d = dt.strptime(start_date, "%Y-%m-%d").date() if start_date else None
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")
    if end_d is None or start_d is None:
        cur_max = None
        conn0 = get_db_connection()
        if conn0:
            try:
                c0 = conn0.cursor()
                c0.execute("SELECT MAX(day) FROM daily_track_coverage")
                cur_max = c0.fetchone()[0]
                c0.close()
            finally:
                conn0.close()
        if end_d is None:
            end_d = min(cur_max, today) if cur_max else today
        if start_d is None:
            start_d = end_d - timedelta(days=6)
    if start_d > end_d:
        start_d, end_d = end_d, start_d

    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
    cur = conn.cursor()
    try:
        cur.execute(
            """
            SELECT d::date AS day,
                   COALESCE(SUM(t.distance_meters), 0) AS distance_meters,
                   COALESCE(SUM(t.point_count), 0)     AS point_count
            FROM generate_series(%s::date, %s::date, '1 day'::interval) d
            LEFT JOIN daily_track_coverage t ON t.day = d::date
            GROUP BY d
            ORDER BY d
            """,
            (start_d, end_d),
        )
        rows = cur.fetchall()

        # Rollup empty for this window → compute live from the source frames
        # (the admin refresh has not been run for recent capture days).
        if not rows or sum(int(r[2]) for r in rows) == 0:
            cur.execute(
                """
                WITH days AS (
                    SELECT d::date AS day
                    FROM generate_series(%s::date, %s::date, '1 day'::interval) d
                ),
                frames AS (
                    SELECT capture_date::date AS day,
                           feature_id,
                           geom,
                           LAG(geom) OVER (
                               PARTITION BY SPLIT_PART(feature_id, '_', 1)
                               ORDER BY capture_date, feature_id
                           ) AS prev_geom
                    FROM image_features_4
                    WHERE is_deleted = FALSE
                      AND capture_date IS NOT NULL
                      AND geom IS NOT NULL
                      AND capture_date::date BETWEEN %s AND %s
                ),
                segs AS (
                    SELECT day,
                           feature_id,
                           CASE WHEN prev_geom IS NULL THEN 0
                                ELSE ST_Distance(
                                     geom,
                                     ST_SetSRID(prev_geom, 4326)::geography
                                 ) END AS seg_m
                    FROM frames
                )
                SELECT days.day,
                       COALESCE(SUM(s.seg_m), 0) AS distance_meters,
                       COUNT(s.feature_id)       AS point_count
                FROM days
                LEFT JOIN segs s ON s.day = days.day
                GROUP BY days.day
                ORDER BY days.day
                """,
                (start_d, end_d, start_d, end_d),
            )
            rows = cur.fetchall()

        return {
            "status": "success",
            "start_date": start_d.isoformat(),
            "end_date": end_d.isoformat(),
            "days": [
                {
                    "day": r[0].isoformat(),
                    "distance_meters": round(float(r[1]), 2),
                    "point_count": int(r[2]),
                }
                for r in rows
            ]
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Daily coverage read failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        cur.close()
        conn.close()


@app.delete("/api/features/delete-batch", dependencies=[Depends(require_admin)])
async def delete_features_batch(request: DeleteFeaturesRequest, background_tasks: BackgroundTasks):
    """
    Soft delete features within a GeoJSON polygon by marking is_deleted as true
    Parameters:
    - geojson: GeoJSON geometry (Polygon or MultiPolygon) to define deletion area
    
    Example request body:
    {
        "geojson": {
            "type": "Polygon",
            "coordinates": [[[lon1, lat1], [lon2, lat2], [lon3, lat3], [lon1, lat1]]]
        }
    }
    """
    conn = None
    try:
        if not request.geojson:
            raise HTTPException(status_code=400, detail="No GeoJSON provided")
        
        # Validate GeoJSON type
        geojson_type = request.geojson.get('type')
        if geojson_type not in ['Polygon', 'MultiPolygon']:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid GeoJSON type: {geojson_type}. Only 'Polygon' and 'MultiPolygon' are supported."
            )
        
        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")
        
        cursor = conn.cursor()
        
        # Convert GeoJSON to WKT format for PostGIS
        geojson_str = json.dumps(request.geojson)
        
        # Find all features within the polygon using PostGIS ST_Within
        # Create geometry from latitude_original and longitude_original
        check_query = """
            SELECT feature_id, is_deleted
            FROM image_features_4
            WHERE ST_Within(
                ST_SetSRID(ST_MakePoint(longitude_original, latitude_original), 4326),
                ST_GeomFromGeoJSON(%s)
            )
        """
        
        cursor.execute(check_query, (geojson_str,))
        features_in_polygon = cursor.fetchall()
        
        if not features_in_polygon:
            cursor.close()
            conn.close()
            return {
                "status": "success",
                "message": "No features found within the polygon",
                "marked_deleted": 0,
                "already_deleted": 0,
                "total_in_polygon": 0,
                "details": {
                    "marked_deleted_ids": [],
                    "already_deleted_ids": []
                }
            }
        
        # Separate features by deletion status
        existing_ids = {row[0]: row[1] for row in features_in_polygon}
        already_deleted = [fid for fid, is_del in existing_ids.items() if is_del]
        to_delete = [fid for fid, is_del in existing_ids.items() if not is_del]
        
        # Mark features as deleted
        deleted_count = 0
        if to_delete:
            placeholders_delete = ','.join(['%s'] * len(to_delete))
            update_query = f"""
                UPDATE image_features_4 
                SET is_deleted = true
                WHERE feature_id IN ({placeholders_delete})
                RETURNING feature_id
            """
            cursor.execute(update_query, to_delete)
            deleted_features = cursor.fetchall()
            deleted_count = len(deleted_features)
            conn.commit()
        
        cursor.close()
        conn.close()
        
        logger.info(f"Marked {deleted_count} features as deleted within polygon")
        
        # Trigger merge in background since data has changed
        if deleted_count > 0:
            background_tasks.add_task(merge_all_track_geojsons)
        
        return {
            "status": "success",
            "message": f"Marked {deleted_count} features as deleted within polygon",
            "marked_deleted": deleted_count,
            "already_deleted": len(already_deleted),
            "total_in_polygon": len(features_in_polygon),
            "details": {
                "marked_deleted_ids": to_delete,
                "already_deleted_ids": already_deleted
            }
        }
        
    except HTTPException as he:
        if conn:
            conn.rollback()
        raise he
    except Exception as e:
        if conn:
            conn.rollback()
        logger.error(f"Batch deletion error: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Deletion failed: {str(e)}")
    finally:
        if conn:
            conn.close()


# ======================
# RECALCULATE SNAPPED COORDINATES ENDPOINTS
# ======================
@app.post("/api/recalculate-snapped-coords", dependencies=[Depends(require_admin)])
async def recalculate_snapped_coords(request: RecalculateSnapRequest, background_tasks: BackgroundTasks):
    """
    Recalculate snapped coordinates for multiple tracks by calling snap-to-road API.
    Processing happens in background.
    
    Parameters:
    - track_numbers: List of track numbers to process (e.g., ["0", "1", "37"])
    
    Returns:
    - job_id: Unique identifier to check processing status
    - status: Initial status ("queued")
    """
    try:
        # Validate track numbers
        if not request.track_numbers:
            raise HTTPException(status_code=400, detail="track_numbers list cannot be empty")
        
        # Generate unique job ID
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        job_id = f"recalc_{timestamp}_{hashlib.md5('_'.join(request.track_numbers).encode()).hexdigest()[:8]}"
        
        # Initialize job status
        recalculate_jobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "track_numbers": request.track_numbers,
            "tracks_processed": [],
            "tracks_failed": [],
            "total_tracks": len(request.track_numbers),
            "total_features_updated": 0,
            "started_at": datetime.now().isoformat(),
            "completed_at": None,
            "error": None
        }
        
        # Verify database connection
        conn = get_db_connection()
        if not conn:
            recalculate_jobs[job_id]["status"] = "failed"
            recalculate_jobs[job_id]["error"] = "Database connection failed"
            raise HTTPException(status_code=503, detail="Database unavailable")
        conn.close()
        
        # Add background task
        background_tasks.add_task(process_recalculation_job, job_id, request.track_numbers)
        
        logger.info(f"Started recalculation job {job_id} for tracks: {request.track_numbers}")
        
        return {
            "status": "success",
            "job_id": job_id,
            "message": f"Recalculation started for {len(request.track_numbers)} track(s)",
            "track_numbers": request.track_numbers,
            "verification_url": f"/api/recalculate-snapped-coords/status/{job_id}"
        }
        
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Error starting recalculation: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


async def process_recalculation_job(job_id: str, track_numbers: List[str]):
    """
    Background task to process recalculation for multiple tracks.
    Updates snapped coordinates by calling Barikoi snap-to-road API.
    """
    try:
        recalculate_jobs[job_id]["status"] = "processing"
        logger.info(f"Job {job_id}: Starting processing")
        
        api_key = Config.BARIKOI_API_KEY
        if not api_key:
            raise Exception("BARIKOI_API_KEY not configured")
        
        total_features_updated = 0
        
        for track_num in track_numbers:
            try:
                logger.info(f"Job {job_id}: Processing track {track_num}")
                
                # Get all coordinates for this track
                conn = get_db_connection()
                if not conn:
                    raise Exception("Database connection failed")
                
                cursor = conn.cursor()
                
                # Get features for this track (exact match to avoid track 21 matching track 210)
                cursor.execute("""
                    SELECT id, feature_id, latitude_original, longitude_original
                    FROM image_features_4
                    WHERE SPLIT_PART(feature_id, '_', 1) = %s
                    ORDER BY CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)
                """, (track_num,))
                
                features = cursor.fetchall()
                feature_count = len(features)
                
                if feature_count == 0:
                    logger.warning(f"Job {job_id}: Track {track_num} not found")
                    recalculate_jobs[job_id]["tracks_failed"].append({
                        "track_number": track_num,
                        "error": "Track not found"
                    })
                    cursor.close()
                    conn.close()
                    continue
                
                logger.info(f"Job {job_id}: Found {feature_count} features in track {track_num}")
                
                # Process each feature
                updated_count = 0
                failed_count = 0
                
                for idx, (db_id, feature_id, lat_orig, lon_orig) in enumerate(features, 1):
                    try:
                        # Call snap-to-road API
                        snap_url = f"http://localhost:8989/nearest?point={lat_orig},{lon_orig}&api_key={api_key}"
                        
                        async with httpx.AsyncClient(timeout=10.0) as client:
                            response = await client.get(snap_url)
                        
                        if response.status_code == 200:
                            snap_data = response.json()
                            
                            if snap_data and 'coordinates' in snap_data:
                                snap_lon, snap_lat = snap_data['coordinates']
                                
                                # Update database
                                cursor.execute("""
                                    UPDATE image_features_4
                                    SET latitude_snapped = %s, longitude_snapped = %s
                                    WHERE id = %s
                                """, (snap_lat, snap_lon, db_id))
                                
                                updated_count += 1
                            else:
                                logger.warning(f"Job {job_id}: No coordinates in API response for {feature_id}")
                                failed_count += 1
                        else:
                            logger.warning(f"Job {job_id}: API error {response.status_code} for {feature_id}")
                            failed_count += 1
                        
                        # Rate limiting
                        await asyncio.sleep(0.1)
                        
                        # Log progress every 100 features
                        if idx % 100 == 0:
                            logger.info(f"Job {job_id}: Processed {idx}/{feature_count} features in track {track_num}")
                    
                    except Exception as e:
                        logger.error(f"Job {job_id}: Error processing feature {feature_id}: {str(e)}")
                        failed_count += 1
                        continue
                
                # Commit changes for this track
                conn.commit()
                cursor.close()
                conn.close()
                
                total_features_updated += updated_count
                
                recalculate_jobs[job_id]["tracks_processed"].append({
                    "track_number": track_num,
                    "features_updated": updated_count,
                    "features_failed": failed_count,
                    "total_features": feature_count
                })
                
                logger.info(f"Job {job_id}: Completed track {track_num} - {updated_count} updated, {failed_count} failed")
                
            except Exception as e:
                logger.error(f"Job {job_id}: Error processing track {track_num}: {str(e)}", exc_info=True)
                recalculate_jobs[job_id]["tracks_failed"].append({
                    "track_number": track_num,
                    "error": str(e)
                })
        
        # Update final job status
        recalculate_jobs[job_id]["status"] = "completed"
        recalculate_jobs[job_id]["total_features_updated"] = total_features_updated
        recalculate_jobs[job_id]["completed_at"] = datetime.now().isoformat()
        
        logger.info(f"Job {job_id}: Completed successfully - {total_features_updated} total features updated")
        
    except Exception as e:
        logger.error(f"Job {job_id}: Fatal error: {str(e)}", exc_info=True)
        recalculate_jobs[job_id]["status"] = "failed"
        recalculate_jobs[job_id]["error"] = str(e)
        recalculate_jobs[job_id]["completed_at"] = datetime.now().isoformat()


@app.get("/api/recalculate-snapped-coords/status/{job_id}")
async def get_recalculation_status(job_id: str):
    """
    Get the status of a recalculation job.
    
    Parameters:
    - job_id: Job identifier returned by /api/recalculate-snapped-coords
    
    Returns:
    - Complete job status including progress and results
    """
    try:
        if job_id not in recalculate_jobs:
            raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
        
        job_status = recalculate_jobs[job_id]
        
        # Calculate progress percentage
        total_tracks = job_status["total_tracks"]
        processed_tracks = len(job_status["tracks_processed"]) + len(job_status["tracks_failed"])
        progress_percentage = (processed_tracks / total_tracks * 100) if total_tracks > 0 else 0
        
        return {
            "status": "success",
            "job": {
                **job_status,
                "progress_percentage": round(progress_percentage, 2),
                "tracks_completed": processed_tracks
            }
        }
        
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Error getting job status: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/recalculate-snapped-coords/jobs")
async def list_recalculation_jobs():
    """
    List all recalculation jobs (recent jobs).
    Returns a summary of all tracked jobs.
    """
    try:
        jobs_summary = []
        
        for job_id, job_data in recalculate_jobs.items():
            jobs_summary.append({
                "job_id": job_id,
                "status": job_data["status"],
                "total_tracks": job_data["total_tracks"],
                "tracks_completed": len(job_data["tracks_processed"]) + len(job_data["tracks_failed"]),
                "total_features_updated": job_data["total_features_updated"],
                "started_at": job_data["started_at"],
                "completed_at": job_data["completed_at"]
            })
        
        # Sort by started_at descending
        jobs_summary.sort(key=lambda x: x["started_at"], reverse=True)
        
        return {
            "status": "success",
            "total_jobs": len(jobs_summary),
            "jobs": jobs_summary
        }
        
    except Exception as e:
        logger.error(f"Error listing jobs: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ======================
# FEATURE DELETION ENDPOINTS
# ======================
# Add this endpoint to api.py for verification before deletion
@app.post("/api/features/verify-deletion")
async def verify_features_deletion(request: DeleteFeaturesRequest):
    """
    Verify which features are within a GeoJSON polygon and their deletion status
    Parameters:
    - geojson: GeoJSON geometry (Polygon or MultiPolygon) to define verification area
    """
    conn = None
    try:
        if not request.geojson:
            raise HTTPException(status_code=400, detail="No GeoJSON provided")
        
        # Validate GeoJSON type
        geojson_type = request.geojson.get('type')
        if geojson_type not in ['Polygon', 'MultiPolygon']:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid GeoJSON type: {geojson_type}. Only 'Polygon' and 'MultiPolygon' are supported."
            )
        
        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")
        
        cursor = conn.cursor()
        
        # Convert GeoJSON to WKT format for PostGIS
        geojson_str = json.dumps(request.geojson)
        
        # Find all features within the polygon
        query = """
            SELECT 
                feature_id, 
                is_deleted,
                latitude_snapped,
                longitude_snapped
            FROM image_features_4
            WHERE ST_Within(
                ST_SetSRID(ST_MakePoint(longitude_original, latitude_original), 4326),
                ST_GeomFromGeoJSON(%s)
            )
            ORDER BY 
                CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER),
                CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)
        """
        
        cursor.execute(query, (geojson_str,))
        features_in_polygon = cursor.fetchall()
        
        cursor.close()
        conn.close()
        
        # Separate by deletion status
        verification_results = []
        active_features = []
        already_deleted = []
        
        for row in features_in_polygon:
            feature_id, is_deleted, lat, lon = row
            feature_info = {
                "feature_id": feature_id,
                "is_deleted": is_deleted,
                "coordinates": [lon, lat]
            }
            verification_results.append(feature_info)
            
            if is_deleted:
                already_deleted.append(feature_id)
            else:
                active_features.append(feature_id)
        
        return {
            "status": "success",
            "total_in_polygon": len(features_in_polygon),
            "active_features": len(active_features),
            "already_deleted": len(already_deleted),
            "features": verification_results,
            "summary": {
                "will_be_deleted": active_features[:10],  # First 10 for preview
                "total_will_be_deleted": len(active_features)
            }
        }
        
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Verification error: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@app.post("/api/features/update-capture-dates", dependencies=[Depends(require_admin)])
async def update_capture_dates(background_tasks: BackgroundTasks):
    """
    Update capture_date column in database using the capture dates API
    """
    try:
        # Run the update in background
        background_tasks.add_task(update_capture_dates_in_db)
        
        return {
            "status": "success",
            "message": "Capture date update started in background"
        }
        
    except Exception as e:
        logger.error(f"Error starting capture date update: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/features/capture-dates")
async def get_capture_dates():
    """
    Get capture dates for all tracks by querying the database.
    Groups features by track number and returns the capture_date for each track.
    """
    try:
        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")
        
        cursor = conn.cursor()
        
        # Query to get distinct tracks with their capture dates
        # We'll get the first image's capture_date for each track
        query = """
            WITH track_data AS (
                SELECT 
                    SPLIT_PART(feature_id, '_', 1) AS track_num,
                    MIN(CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)) AS min_image_num
                FROM image_features_4
                GROUP BY SPLIT_PART(feature_id, '_', 1)
            )
            SELECT 
                'track' || td.track_num AS folder_name,
                td.track_num,
                img.capture_date,
                img.feature_id
            FROM track_data td
            JOIN image_features_4 img ON 
                SPLIT_PART(img.feature_id, '_', 1) = td.track_num
                AND CAST(SPLIT_PART(img.feature_id, '_', 2) AS INTEGER) = td.min_image_num
            ORDER BY CAST(td.track_num AS INTEGER)
        """
        
        cursor.execute(query)
        rows = cursor.fetchall()
        
        results = []
        for row in rows:
            folder_name, track_num, capture_date, feature_id = row
            
            if capture_date:
                # Format datetime to ISO string
                captured_datetime = capture_date.strftime('%Y-%m-%dT%H:%M:%S')
                captured_date = capture_date.strftime('%Y-%m-%d')
            else:
                captured_datetime = None
                captured_date = "Unknown"
            
            results.append({
                "folder_name": folder_name,
                "track_number": track_num,
                "first_feature_id": feature_id,
                "captured_datetime": captured_datetime,
                "captured_date": captured_date
            })
        
        cursor.close()
        conn.close()
        
        return {
            "status": "success",
            "data": results,
            "count": len(results)
        }
            
    except Exception as e:
        logger.error(f"Error getting capture dates from database: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))



@app.get("/api/features/{feature_id}")
async def get_feature_by_id(feature_id: str):
    """
    Get a single feature by its feature_id (e.g., "0_3") and return as GeoJSON.
    Includes previous_id and next_id based on correct global track/image integer ordering.
    """
    try:
        # Validate feature_id format
        if not feature_id or "_" not in feature_id:
            raise HTTPException(
                status_code=400,
                detail="Invalid feature_id format. Expected format: 'track_image' (e.g., '0_3')"
            )

        track_num, image_num = feature_id.split("_")
        track_num = int(track_num)
        image_num = int(image_num)

        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")

        cursor = conn.cursor()

        # Get the current feature
        query_feature = """
            SELECT 
                id,
                feature_id,
                image_url_high,
                image_url_comp,
                initial_yaw,
                initial_pitch,
                initial_hfov,
                show_compass,
                longitude_original,
                latitude_original,
                longitude_snapped,
                latitude_snapped,
                capture_date,
                created_at
            FROM image_features_4 
            WHERE feature_id = %s
            LIMIT 1
        """
        cursor.execute(query_feature, (feature_id,))
        row = cursor.fetchone()

        if not row:
            raise HTTPException(
                status_code=404,
                detail=f"Feature with ID '{feature_id}' not found"
            )

        # --- Previous ID (global across tracks) ---
        cursor.execute(
            """
            SELECT feature_id
            FROM image_features_4
            WHERE (
                    CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER),
                    CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)
                  )
                  < (%s, %s)
            ORDER BY CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER) DESC,
                     CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER) DESC
            LIMIT 1
            """,
            (track_num, image_num)
        )
        prev_row = cursor.fetchone()
        previous_id = prev_row[0] if prev_row else None

        # --- Next ID (global across tracks) ---
        cursor.execute(
            """
            SELECT feature_id
            FROM image_features_4
            WHERE (
                    CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER),
                    CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)
                  )
                  > (%s, %s)
            ORDER BY CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER) ASC,
                     CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER) ASC
            LIMIT 1
            """,
            (track_num, image_num)
        )
        next_row = cursor.fetchone()
        next_id = next_row[0] if next_row else None

        # Format capture_date
        capture_date = row[12]
        if capture_date:
            capture_date_display = capture_date.strftime('%B %d, %Y')
            capture_date_iso = capture_date.isoformat()
            capture_date_timestamp = capture_date.timestamp()
        else:
            capture_date_display = "Unknown"
            capture_date_iso = None
            capture_date_timestamp = None



        drive_high_id = row[2]
        drive_comp_id = row[3]

        drive_high_id = f"https://drive.usercontent.google.com/download?id={drive_high_id.rsplit('/', 1)[-1]}"
        drive_comp_id = f"https://drive.usercontent.google.com/download?id={drive_comp_id.rsplit('/', 1)[-1]}"
        # Build GeoJSON
        feature = {
            "type": "Feature",
            "properties": {
                "id": row[1],  # feature_id as id
                "imageUrl_High": row[2],
                "imageUrl_Comp": row[3],
                "driveUrl_High": row[2],
                "driveUrl_Comp": row[3],
                "initialYaw": row[4],
                "initialPitch": row[5],
                "initialHfov": row[6],
                "showCompass": row[7],
                "longitude_original": row[8],
                "latitude_original": row[9],
                "longitude_snapped": row[10],
                "latitude_snapped": row[11],
                "capture_date": capture_date_display,
                "capture_date_raw": capture_date_iso,
                "capture_date_timestamp": capture_date_timestamp,
                "created_at": row[13].isoformat() if row[13] else None,
                "previous_id": previous_id,
                "next_id": next_id
            },
            "geometry": {
                "type": "Point",
                "coordinates": [row[10], row[11]]  # original coordinates
            }
        }

        cursor.close()
        conn.close()

        return feature

    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Error getting feature {feature_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# Generate POIs
@app.post("/api/generate-poi", response_model=POIResult)
async def generate_poi(request: POIRequest):
    """
    Extract POIs (Points of Interest) from an image using Together AI vision model
    Parameters:
    - image_url: Full URL to the image to extract POIs from (e.g., Google Drive URL)
    - latitude: Optional latitude for storing POIs in database
    - longitude: Optional longitude for storing POIs in database
    - feature_id: Optional feature ID for reference (defaults to "direct_url")
    """
    try:
        # Validate image_url
        if not request.image_url:
            raise HTTPException(
                status_code=400,
                detail="image_url is required"
            )

        # Extract POIs using Together AI
        together_api_key = os.getenv('TOGETHER_API_KEY')
        if not together_api_key:
            raise HTTPException(
                status_code=500,
                detail="Together AI API key not configured"
            )

        # Extract POIs directly from the provided image URL
        pois = await extract_pois_from_image_url_direct(request.image_url, together_api_key)
        
        # Store POIs in database if coordinates are provided
        inserted_count = 0
        if request.latitude is not None and request.longitude is not None:
            feature_id = request.feature_id or "direct_url"
            inserted_count = await store_pois_in_db(
                pois=pois,
                latitude=request.latitude,
                longitude=request.longitude,
                image_url=request.image_url,
                source_id=feature_id
            )
            logger.info(f"Stored {inserted_count} POIs in database for {feature_id}")
        
        return POIResult(
            status="success",
            message=f"Extracted {len(pois)} POIs from image" + (f", stored {inserted_count} in database" if inserted_count > 0 else ""),
            pois=pois,
            feature_id=request.feature_id or "direct_url",
            processed_count=inserted_count if inserted_count > 0 else len(pois)
        )

    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"POI extraction error: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"POI extraction failed: {str(e)}"
        )

# Extract POIs from image URL directly (simplified version with comprehensive bilingual prompt)
async def extract_pois_from_image_url_direct(image_url: str, together_api_key: str) -> List[POIResponse]:
    """Extract POIs from image URL using Together AI vision model with comprehensive bilingual prompt"""
    try:
        from together import Together
        
        system_prompt = """You are an expert computer vision system specialized in detecting and extracting Points of Interest (POIs) from 360-DEGREE PANORAMIC street-view images in BANGLADESH. Your task is to perform ULTRA-EXHAUSTIVE text detection and business identification.

🌐 360-DEGREE IMAGE UNDERSTANDING:
- This is a FLATTENED 360° panoramic view (equirectangular projection)
- The left and right edges CONNECT - they represent the same physical location
- Text at edges may appear stretched, distorted, or split across the wraparound
- The center of the image is typically FRONT-FACING with least distortion
- Objects near edges may appear elongated or warped due to panoramic projection
- Scan the FULL WIDTH as it represents a complete 360° view around the camera

🇧🇩 CRITICAL: BILINGUAL TEXT DETECTION (BENGALI + ENGLISH)
- This is from BANGLADESH - expect text in BOTH BENGALI (বাংলা) and ENGLISH
- **DETECT BOTH SCRIPTS EQUALLY**: You MUST catch ALL Bengali AND English text
- Bengali script characters: আ, ক, খ, গ, ঘ, ঙ, চ, ছ, জ, ঝ, ঞ, ট, ঠ, ড, ঢ, ণ, ত, থ, দ, ধ, ন, প, ফ, ব, ভ, ম, য, র, ল, শ, ষ, স, হ, etc.
- English script: A-Z, a-z (Latin alphabet)
- **BILINGUAL SIGNS**: Many signs have BOTH languages - if Bengali and English appear on THE SAME physical sign, include BOTH in the text field
- Bengali text appears as: দোকান (shop), ব্যাংক (bank), ফার্মেসি (pharmacy), হাসপাতাল (hospital), রেস্তোরাঁ (restaurant), মোবাইল (mobile), কাপড় (clothes)
- English text appears as: Shop, Store, Bank, Hospital, Pharmacy, Mobile, Fashion, etc.
- **CRITICAL**: Do NOT skip English text - it appears frequently alongside Bengali
- **CRITICAL**: Do NOT skip Bengali text - it is the primary language
- If you cannot read Bengali OR English clearly, include it with lower confidence rather than omitting it
- Bengali numerals (০১২৩৪৫৬৭৮৯) and English numerals (0123456789) both appear in addresses/phones

⚠️ ULTRA-CRITICAL DETECTION RULES - READ CAREFULLY:
1. Scan the ENTIRE image systematically - LEFT EDGE → CENTER → RIGHT EDGE (full 360° coverage)
2. Detect EVERY SINGLE signboard, banner, shop sign, or text display - count each physical sign as ONE POI
3. **ONE SIGNBOARD = ONE POI**: Do NOT break down compound text. If a sign says "Diamond Sweater Industries Ltd.", create ONE entry with the full text
4. **BILINGUAL DETECTION**: Detect BOTH Bengali (বাংলা) AND English text on every sign
   - If a sign has "মোবাইল শপ" AND "Mobile Shop" on it, include BOTH in the text field: "মোবাইল শপ Mobile Shop"
   - If a sign has ONLY Bengali, write only Bengali text
   - If a sign has ONLY English, write only English text
5. Detect text on: signboards, storefronts, banners, windows, walls, vehicles, billboards, awnings, flags, posters, doors, gates, railings, rickshaws
6. **COUNT EACH PHYSICAL SIGN SEPARATELY**: If the same business name appears on 3 different signs/locations, count all 3 as separate POIs
7. Include partially visible text - even if only 20-30% is readable, include it with lower confidence
8. Detect text behind obstacles (trees, poles, wires, other signs) - look between gaps
9. Detect text at ANY angle (tilted, rotated, curved, distorted, stretched by panorama, upside down)
10. Include VERY small text (window stickers, phone numbers, small labels, vehicle text, rickshaw text)
11. Look for text in shadows, reflections, glass reflections, or low-light areas
12. Detect text on VEHICLES (cars, rickshaws, trucks, buses, CNGs) - each vehicle with text counts as one POI
13. **REPEATED SIGNBOARDS**: If "DBL" appears on 3 different physical signs, list all 3 instances separately (but don't break down the text on each sign)
14. Pay EXTRA attention to edge regions - text may be warped but still readable
15. Look for PARTIAL words split across signs or wrapping at edges
16. Include SINGLE letters or numbers if they appear to be separate signage (like standalone "M", "24", "7", "০১")
17. **DETECT BOTH SCRIPTS**: Bengali numerals (০১২৩৪৫৬৭৮৯) AND English numerals (0123456789)
18. **DO NOT DECOMPOSE TEXT**: Each physical signboard/banner = ONE entry with complete text (including both Bengali and English if present)

FOR EACH POI DETECTED, PROVIDE:
- 'text': The EXACT text as written (preserve original spelling, capitalization, and language)
- 'type': Business/place category (Restaurant, Shop, Bank, Clinic, Office, Pharmacy, Salon, Store, Service, etc.)
- 'language': Detected language(s) - be specific (Bengali, English, Bangla+English mix, Arabic, Hindi, etc.)
- 'location': Precise position in the 360° panorama:
  * Horizontal: Use descriptive zones - "far left edge", "left quarter", "center-left", "center/front", "center-right", "right quarter", "far right edge"
  * Vertical: "top", "upper-middle", "middle", "lower-middle", "bottom"
  * Combined: e.g., "far left edge, upper-middle", "center-right, bottom on blue sign"
  * Note: Left and right edges are physically close (360° wraparound)
- 'confidence': Score 0.0-1.0 based on:
  * 1.0: Perfect clarity, fully visible, minimal panoramic distortion
  * 0.8-0.9: Clear but slightly angled, small, or edge-distorted
  * 0.6-0.7: Partially obscured, readable despite distortion
  * 0.4-0.5: Heavily obscured, faint, very small, or significantly warped but text is distinguishable
  * 0.2-0.3: Barely visible, highly uncertain, severe edge distortion

🎯 MANDATORY QUALITY TARGETS FOR 360° IMAGES:
- **MINIMUM TARGET: 20+ POIs** (counting each physical signboard/banner separately)
- **OPTIMAL TARGET: 30-40+ POIs** (each unique signboard = one POI)
- **BILINGUAL TARGET**: Expect roughly 50% Bengali, 30% English, 20% mixed/bilingual signs
- The 360° format means you're seeing BEHIND, BESIDE, and AHEAD - expect MANY signboards
- Count detected POIs before responding - if below 20, scan again with focus on:
  * **Bengali signboards** (দোকান, ব্যাংক, ফার্মেসি, etc.)
  * **English signboards** (Shop, Bank, Pharmacy, etc.)
  * **Bilingual signs** (signs with BOTH Bengali and English)
  * Window labels (each window label = one POI, include both scripts if present)
  * Vehicle text (each vehicle with text = one POI, often has both Bengali and English)
  * **Different physical signs** (if "DBL" appears on 3 different signboards, count 3 POIs)
  * Partial signboards (cut-off or partially visible signs at edges)
  * Small signboards and stickers (door numbers, phone stickers with ০১ or 01)
  * Background signboards (signs behind main signage)
- **COUNT RULE**: Each separate physical signboard/banner/sticker = ONE POI (include all text from that sign, both Bengali and English)
- Pay special attention to LEFT and RIGHT EDGES - these areas often contain 20-30% of all signboards
- When uncertain about warped/distorted text at edges, include it with appropriate low confidence (0.3-0.5) rather than omitting it
- ALWAYS prefer over-detection to under-detection - include every signboard with appropriate confidence scores
- **DETECT BOTH SCRIPTS**: Do not miss Bengali OR English text

OUTPUT FORMAT:
Return ONLY a valid JSON array. No explanations, no preamble, no markdown formatting.

**MANDATORY**: You MUST find all the POI's included in the photo. Count each signboard or board or banner or poster or whatever, as individual POI. don't break one banners text to multiple poi.
- All partial/cut-off text
- All window text and small labels  
- All vehicle text
- All repeated instances (count separately)
- Ignore all small paper (poster)

Take your time. Scan methodically. Include everything. Do not rush."""

        # Initialize Together AI client
        client = Together(api_key=together_api_key)
        
        # Use vision-capable model
        response = client.chat.completions.create(
            model="meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": system_prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": image_url,
                            },
                        },
                    ],
                }
            ],
            max_tokens=4000,
            temperature=0.7,
            top_p=0.7,
            top_k=50,
            repetition_penalty=1,
            stop=["<|eot_id|>", "<|eom_id|>"]
        )

        content = response.choices[0].message.content
        
        # Clean up the response (handle code blocks)
        content = content.strip()
        if content.startswith("```"):
            # Extract JSON from code block
            lines = content.split('\n')
            json_lines = []
            in_code_block = False
            for line in lines:
                if line.startswith("```"):
                    in_code_block = not in_code_block
                    continue
                if in_code_block or (not line.startswith("```") and "[" in line):
                    json_lines.append(line)
            content = '\n'.join(json_lines).strip()
        
        # Find JSON array in response
        start_idx = content.find('[')
        end_idx = content.rfind(']') + 1
        if start_idx != -1 and end_idx > start_idx:
            content = content[start_idx:end_idx]
        
        # Parse JSON response
        poi_data = json.loads(content)
        
        # Convert to POIResponse objects
        pois = []
        for item in poi_data:
            pois.append(POIResponse(
                text=item.get("text", ""),
                type=item.get("type", "Unknown"),
                language=item.get("language", "Unknown"),
                location=item.get("location", ""),
                confidence=item.get("confidence", 0.5),
                target_latitude=item.get("target_latitude"),
                target_longitude=item.get("target_longitude")
            ))
        
        logger.info(f"Together AI extracted {len(pois)} POIs from image URL")
        return pois

    except Exception as e:
        logger.error(f"Together AI POI extraction failed: {str(e)}", exc_info=True)
        raise

# Extract POIs from image URL (more efficient - no base64 encoding)
async def extract_pois_from_image_url(image_url: str, together_api_key: str) -> List[POIResponse]:
    """Extract POIs from image using Together AI vision model with direct URL"""
    try:
        from together import Together
        
        # Convert local path to accessible URL if needed
        if not image_url.startswith('http'):
            # This is a local path, construct full URL
            image_url = f"{API_IMAGE_URL}/{image_url.lstrip('/')}"

        system_prompt = """You are an expert POI (Point of Interest) detection assistant. Analyze this image and detect EVERY visible text that could be a business, shop, signboard, or service. Include:
- Partially visible text
- Foreign language text (e.g., Bengali, Arabic, Hindi, etc.)
- Small or faint signs
- Signs behind obstacles or at angles

Return a JSON array with these fields for each POI:
- 'text': exact text visible
- 'type': guessed shop/business type
- 'language': language(s) of the text
- 'location': approximate location in image (e.g., 'top-right, green signboard')
- 'confidence': 0–1 confidence score

Rules:
1. Include ALL text even partially readable
2. Be exhaustive - don't limit results
3. Return ONLY valid JSON array
4. No explanations, just the JSON

Example format:
[
  {"text": "Tasty Village", "type": "Restaurant", "language": "English", "location": "center-left", "confidence": 0.95},
  {"text": "গ্লোরি ইসলামী ব্যাংক", "type": "Bank", "language": "Bengali", "location": "top-right", "confidence": 0.88}
]"""

        # Initialize Together AI client
        client = Together(api_key=together_api_key)
        
        # Use vision-capable model with image URL
        response = client.chat.completions.create(
            model="meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": system_prompt},
                        {"type": "image_url", "image_url": {"url": image_url}},
                    ],
                }
            ],
            max_tokens=4000,
            temperature=0.7,
            top_p=0.7,
            top_k=50,
            repetition_penalty=1,
        )

        content = response.choices[0].message.content
        logger.info(f"Together AI response: {content[:200]}...")
        
        # Clean up the response (handle code blocks)
        content = content.strip()
        if content.startswith("```"):
            # Extract JSON from code block
            lines = content.split('\n')
            json_lines = []
            in_code_block = False
            for line in lines:
                if line.startswith("```"):
                    in_code_block = not in_code_block
                    continue
                if in_code_block or (not line.startswith("```") and "[" in line):
                    json_lines.append(line)
            content = '\n'.join(json_lines).strip()
        
        # Find JSON array in response
        start_idx = content.find('[')
        end_idx = content.rfind(']') + 1
        if start_idx != -1 and end_idx > start_idx:
            content = content[start_idx:end_idx]
        
        # Parse JSON response
        poi_data = json.loads(content)
        
        # Convert to POIResponse objects
        pois = []
        for item in poi_data:
            pois.append(POIResponse(
                text=item.get("text", ""),
                type=item.get("type", "Unknown"),
                language=item.get("language", "Unknown"),
                location=item.get("location", ""),
                confidence=item.get("confidence", 0.5),
                target_latitude=item.get("target_latitude"),
                target_longitude=item.get("target_longitude")
            ))
        
        logger.info(f"Together AI extracted {len(pois)} POIs from image URL")
        return pois

    except Exception as e:
        logger.error(f"Together AI POI extraction failed: {str(e)}", exc_info=True)
        raise

# Extract POIs from image
async def extract_pois_from_image(image_path: str, together_api_key: str) -> List[POIResponse]:
    """Extract POIs from image using Together AI vision model"""
    try:
        from together import Together
        
        # Encode image
        with open(image_path, "rb") as f:
            base64_image = base64.b64encode(f.read()).decode("utf-8")
        
        mime_type, _ = mimetypes.guess_type(image_path)
        if mime_type is None:
            mime_type = "image/jpeg"

        system_prompt = """You are an expert POI (Point of Interest) detection assistant. Analyze this image and detect EVERY visible text that could be a business, shop, signboard, or service. Include:
- Partially visible text
- Foreign language text (e.g., Bengali)
- Small or faint signs
- Signs behind obstacles or at angles

Return a JSON array with these fields for each POI:
- 'text': exact text visible
- 'type': guessed shop/business type
- 'language': language(s) of the text
- 'location': approximate location in image (e.g., 'top-right, green signboard')
- 'confidence': 0–1 confidence score

Rules:
1. Include ALL text even partially readable
2. Be exhaustive - don't limit results
3. Return ONLY valid JSON array
4. No explanations, just the JSON

Example format:
[
  {"text": "Tasty Village", "type": "Restaurant", "language": "English", "location": "center-left, above red awning", "confidence": 0.95},
  {"text": "গ্লোরি ইসলামী ব্যাংক", "type": "Bank", "language": "Bengali", "location": "top-right, green signboard", "confidence": 0.88}
]"""

        # Initialize Together AI client
        client = Together(api_key=together_api_key)
        
        # Use vision-capable model (Llama 3.2 Vision or similar)
        response = client.chat.completions.create(
            model="meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": system_prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{mime_type};base64,{base64_image}",
                            },
                        },
                    ],
                }
            ],
            max_tokens=4000,
            temperature=0.7,
            top_p=0.7,
            top_k=50,
            repetition_penalty=1,
            stop=["<|eot_id|>", "<|eom_id|>"]
        )

        content = response.choices[0].message.content
        
        # Clean up the response (handle code blocks)
        content = content.strip()
        if content.startswith("```"):
            # Extract JSON from code block
            lines = content.split('\n')
            json_lines = []
            in_code_block = False
            for line in lines:
                if line.startswith("```"):
                    in_code_block = not in_code_block
                    continue
                if in_code_block or (not line.startswith("```") and "[" in line):
                    json_lines.append(line)
            content = '\n'.join(json_lines).strip()
        
        # Find JSON array in response
        start_idx = content.find('[')
        end_idx = content.rfind(']') + 1
        if start_idx != -1 and end_idx > start_idx:
            content = content[start_idx:end_idx]
        
        # Parse JSON response
        poi_data = json.loads(content)
        
        # Convert to POIResponse objects
        pois = []
        for item in poi_data:
            pois.append(POIResponse(
                text=item.get("text", ""),
                type=item.get("type", "Unknown"),
                language=item.get("language", "Unknown"),
                location=item.get("location", ""),
                confidence=item.get("confidence", 0.5),
                target_latitude=item.get("target_latitude"),
                target_longitude=item.get("target_longitude")
            ))
        
        logger.info(f"Together AI extracted {len(pois)} POIs from image")
        return pois

    except Exception as e:
        logger.error(f"Together AI POI extraction failed: {str(e)}", exc_info=True)
        raise

async def store_pois_in_db(pois: List[POIResponse], latitude: float, longitude: float, 
                          image_url: str, source_id: str) -> int:
    """Store extracted POIs in database"""
    conn = None
    try:
        conn = get_db_connection()
        if not conn:
            logger.error("Database connection failed for POI storage")
            return 0

        cursor = conn.cursor()
        inserted_count = 0

        for poi in pois:
            cursor.execute("""
                INSERT INTO poi_data (
                    source_id, text, location, type, language,
                    confidence, target_latitude, target_longitude,
                    latitude, longitude, image_url, original_geom
                )
                VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    ST_SetSRID(ST_Point(%s, %s), 4326)
                )
            """, (
                source_id,
                poi.text,
                poi.location,
                poi.type,
                poi.language,
                poi.confidence,
                poi.target_latitude,
                poi.target_longitude,
                latitude,
                longitude,
                image_url,
                longitude,  # X = lon
                latitude    # Y = lat
            ))
            inserted_count += 1

        conn.commit()
        logger.info(f"Inserted {inserted_count} POIs for feature {source_id}")
        return inserted_count

    except Exception as e:
        logger.error(f"Failed to store POIs in database: {str(e)}")
        if conn:
            conn.rollback()
        return 0
    finally:
        if conn:
            conn.close()

# Enhanced version with type filtering
# ----------------------
# BARIKOI NEARBY POI PROXY (street-view markers)
# ----------------------
_BARIKOI_POI_CACHE = {}
_BARIKOI_POI_TTL_SECONDS = 60


@app.get("/api/pois/nearby")
async def get_barikoi_nearby_pois(lat: float, lon: float, radius_km: float = 0.2, limit: int = 15):
    """Proxy to the Barikoi Nearby API for the street-view POI markers.

    The Barikoi API key never leaves the server. A short in-memory cache per
    rounded coordinate keeps stepping along a track from re-querying Barikoi
    for every frame. Never raises for upstream failures — the viewer treats
    empty places as "no markers".
    """
    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise HTTPException(status_code=400, detail="Invalid coordinates")
    limit = max(1, min(int(limit), 30))

    cache_key = f"{round(lat, 5)}:{round(lon, 5)}:{radius_km}:{limit}"
    now = datetime.now().timestamp()
    cached = _BARIKOI_POI_CACHE.get(cache_key)
    if cached and cached[0] > now:
        return {"status": "success", "places": cached[1], "cached": True}

    api_key = os.getenv("BARIKOI_NEARBY_API_KEY") or Config.BARIKOI_API_KEY
    url = (
        f"https://barikoi.xyz/v2/api/search/nearby/{radius_km}/{limit}"
        f"?api_key={api_key}&longitude={lon}&latitude={lat}"
    )
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            logger.warning(f"Barikoi nearby returned HTTP {resp.status_code}")
            return {
                "status": "success",
                "places": [],
                "message": f"Barikoi returned HTTP {resp.status_code}",
            }
        payload = resp.json()
        places = payload.get("places") or []
        normalized = []
        for p in places:
            normalized.append({
                "id": str(p.get("id") or p.get("place_code") or ""),
                "place_code": p.get("place_code"),
                "name": p.get("name") or "Unnamed place",
                "address": p.get("address")
                or ", ".join(filter(None, [p.get("area"), p.get("city")]))
                or "",
                "category": p.get("type"),
                "sub_category": p.get("sub_type"),
                "lat": p.get("latitude"),
                "lon": p.get("longitude"),
            })
        _BARIKOI_POI_CACHE[cache_key] = (now + _BARIKOI_POI_TTL_SECONDS, normalized)
        if len(_BARIKOI_POI_CACHE) > 500:
            for old_key in list(_BARIKOI_POI_CACHE)[:100]:
                _BARIKOI_POI_CACHE.pop(old_key, None)
        return {"status": "success", "places": normalized}
    except Exception as e:
        logger.error(f"Barikoi nearby lookup failed: {e}")
        return {"status": "success", "places": [], "message": "Nearby lookup failed"}


@app.get("/api/point-of-interest")
async def get_pois_nearby(
    lat: float,
    lon: float,
    rad: float = 1000.0,
    poi_type: str = None,
    min_confidence: float = None,
    limit: int = 100
):
    """
    Get Points of Interest (POIs) within a specified radius of given coordinates.
    """
    conn = None
    cursor = None

    try:
        # Validate parameters
        if not (-90 <= lat <= 90):
            raise HTTPException(status_code=400, detail="Latitude must be between -90 and 90")
        if not (-180 <= lon <= 180):
            raise HTTPException(status_code=400, detail="Longitude must be between -180 and 180")
        if rad <= 0 or rad > 100000:
            raise HTTPException(status_code=400, detail="Radius must be between 1 and 100000 meters")
        if limit <= 0 or limit > 1000:
            raise HTTPException(status_code=400, detail="Limit must be between 1 and 1000")
        if min_confidence and not (0 <= min_confidence <= 1):
            raise HTTPException(status_code=400, detail="Confidence must be between 0.0 and 1.0")

        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")

        conn.set_session(isolation_level="READ COMMITTED")
        cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

        # Build query
        base_query = """
            SELECT 
                id,
                latitude,
                longitude,
                target_latitude,
                target_longitude,
                ST_AsText(original_geom) as original_geom_wkt,
                confidence,
                source_id,
                text,
                location,
                type,
                language,
                image_url,
                ST_Distance(
                    original_geom::geography, 
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                ) as distance_meters
            FROM poi_data 
            WHERE ST_DWithin(
                original_geom::geography,
                ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                %s
            )
        """

        params = [lon, lat, lon, lat, rad]
        filters = []

        if poi_type:
            filters.append("type = %s")
            params.append(poi_type)
        if min_confidence is not None:
            filters.append("confidence >= %s")
            params.append(min_confidence)

        if filters:
            base_query += " AND " + " AND ".join(filters)

        base_query += " ORDER BY distance_meters ASC LIMIT %s"
        params.append(limit)

        cursor.execute(base_query, params)
        rows = cursor.fetchall()

        pois = []
        for row in rows:
            pois.append({
                "id": row["id"],
                "latitude": row["latitude"],
                "longitude": row["longitude"],
                "target_latitude": row["target_latitude"],
                "target_longitude": row["target_longitude"],
                "original_geom": row["original_geom_wkt"],
                "confidence": row["confidence"],
                "source_id": row["source_id"],
                "text": row["text"],
                "location": row["location"],
                "type": row["type"],
                "language": row["language"],
                "image_url": row["image_url"],
                "distance_meters": round(float(row["distance_meters"]), 2)
            })

        return {
            "status": "success",
            "count": len(pois),
            "search_center": {"latitude": lat, "longitude": lon},
            "search_radius_meters": rad,
            "filters": {
                "type": poi_type,
                "min_confidence": min_confidence
            },
            "pois": pois
        }

    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Unexpected error in POI search: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


@app.get("/api/single-image")
async def get_nearest_image(
    latitude: float,
    longitude: float,
    max_distance: float = 1000.0,
    use_snapped_coords: bool = True
):
    """
    Find the nearest image to the given latitude-longitude coordinates and return as GeoJSON.
    Includes previous_id and next_id based on correct global track/image integer ordering.
    
    Parameters:
    - latitude: Target latitude (required)
    - longitude: Target longitude (required)  
    - max_distance: Maximum search distance in meters (default: 1000.0)
    - use_snapped_coords: Whether to use snapped coordinates for distance calculation (default: True)
    
    Returns:
    - Nearest image feature with distance information in same format as /api/features/{feature_id}
    """
    try:
        # Validate coordinates
        if not (-90 <= latitude <= 90):
            raise HTTPException(
                status_code=400, 
                detail="Latitude must be between -90 and 90"
            )
        if not (-180 <= longitude <= 180):
            raise HTTPException(
                status_code=400, 
                detail="Longitude must be between -180 and 180"
            )
        if max_distance <= 0 or max_distance > 50000:
            raise HTTPException(
                status_code=400, 
                detail="Max distance must be between 1 and 50000 meters"
            )

        conn = get_db_connection()
        if not conn:
            raise HTTPException(status_code=500, detail="Database connection failed")

        cursor = conn.cursor()

        # Choose coordinate columns based on preference
        lat_col = "latitude_snapped" if use_snapped_coords else "latitude_original"
        lon_col = "longitude_snapped" if use_snapped_coords else "longitude_original"
        
        # Find nearest feature within max_distance
        query_nearest = f"""
            SELECT 
                id,
                feature_id,
                image_url_high,
                image_url_comp,
                initial_yaw,
                initial_pitch,
                initial_hfov,
                show_compass,
                longitude_original,
                latitude_original,
                longitude_snapped,
                latitude_snapped,
                capture_date,
                created_at,
                ST_Distance(
                    ST_SetSRID(ST_MakePoint({lon_col}, {lat_col}), 4326)::geography,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                ) as distance_meters
            FROM image_features_4 
            WHERE 
                {lat_col} IS NOT NULL 
                AND {lon_col} IS NOT NULL
                AND ST_DWithin(
                    ST_SetSRID(ST_MakePoint({lon_col}, {lat_col}), 4326)::geography,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                    %s
                )
            ORDER BY distance_meters ASC
            LIMIT 1
        """
        
        cursor.execute(query_nearest, (longitude, latitude, longitude, latitude, max_distance))
        row = cursor.fetchone()

        if not row:
            # Instead of fallback, return error with helpful message
            # Optionally, find the actual nearest distance for the error message
            nearest_query = f"""
                SELECT 
                    ST_Distance(
                        ST_SetSRID(ST_MakePoint({lon_col}, {lat_col}), 4326)::geography,
                        ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                    ) as distance_meters
                FROM image_features_4 
                WHERE {lat_col} IS NOT NULL AND {lon_col} IS NOT NULL
                ORDER BY distance_meters ASC
                LIMIT 1
            """
            cursor.execute(nearest_query, (longitude, latitude))
            nearest_row = cursor.fetchone()
            
            cursor.close()
            conn.close()
            
            if nearest_row:
                actual_distance = round(float(nearest_row[0]), 2)
                raise HTTPException(
                    status_code=404,
                    detail=f"No images found within {max_distance} meters. Nearest image is {actual_distance} meters away."
                )
            else:
                raise HTTPException(
                    status_code=404,
                    detail=f"No images found within {max_distance} meters of the specified coordinates"
                )

        # Extract feature_id for previous/next queries
        feature_id = row[1]
        track_num, image_num = feature_id.split("_")
        track_num = int(track_num)
        image_num = int(image_num)

        # --- Previous ID (global across tracks) ---
        cursor.execute(
            """
            SELECT feature_id
            FROM image_features_4
            WHERE (
                    CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER),
                    CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)
                  )
                  < (%s, %s)
            ORDER BY CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER) DESC,
                     CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER) DESC
            LIMIT 1
            """,
            (track_num, image_num)
        )
        prev_row = cursor.fetchone()
        previous_id = prev_row[0] if prev_row else None

        # --- Next ID (global across tracks) ---
        cursor.execute(
            """
            SELECT feature_id
            FROM image_features_4
            WHERE (
                    CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER),
                    CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)
                  )
                  > (%s, %s)
            ORDER BY CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER) ASC,
                     CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER) ASC
            LIMIT 1
            """,
            (track_num, image_num)
        )
        next_row = cursor.fetchone()
        next_id = next_row[0] if next_row else None

        # Format capture_date
        capture_date = row[12]
        if capture_date:
            capture_date_display = capture_date.strftime('%B %d, %Y')
            capture_date_iso = capture_date.isoformat()
            capture_date_timestamp = capture_date.timestamp()
        else:
            capture_date_display = "Unknown"
            capture_date_iso = None
            capture_date_timestamp = None



        drive_high_id = row[2]
        drive_comp_id = row[3]

        drive_high_id = f"https://drive.usercontent.google.com/download?id={drive_high_id.rsplit('/', 1)[-1]}"
        drive_comp_id = f"https://drive.usercontent.google.com/download?id={drive_comp_id.rsplit('/', 1)[-1]}"

        # Build GeoJSON (following same structure as get_feature_by_id)
        feature = {
            "type": "Feature",
            "properties": {
                "id": row[1],
                "imageUrl_High": row[2],
                "imageUrl_Comp": row[3],
                "driveUrl_High": drive_high_id,
                "driveUrl_Comp": drive_comp_id,
                "initialYaw": row[4],
                "initialPitch": row[5],
                "initialHfov": row[6],
                "showCompass": row[7],
                "longitude_original": row[8],
                "latitude_original": row[9],
                "longitude_snapped": row[10],
                "latitude_snapped": row[11],
                "capture_date": capture_date_display,
                "capture_date_raw": capture_date_iso,
                "capture_date_timestamp": capture_date_timestamp,
                "created_at": row[13].isoformat() if row[13] else None,
                "previous_id": previous_id,
                "next_id": next_id,
                "distance": round(float(row[14]), 2)
            },
            "geometry": {
                "type": "Point",
                "coordinates": [row[10], row[11]]
            }
        }

        cursor.close()
        conn.close()

        return feature

    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Error finding nearest image to ({latitude}, {longitude}): {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# Legacy function kept for backwards compatibility
# Use run_api.py instead for standalone execution
def start_fastapi():
    """
    Deprecated: Use run_api.py to start FastAPI independently.
    This function is kept for backwards compatibility only.
    """
    import warnings
    warnings.warn(
        "start_fastapi() is deprecated. Run FastAPI independently using run_api.py",
        DeprecationWarning,
        stacklevel=2
    )
    uvicorn.run(app, host="0.0.0.0", port=8001, timeout_keep_alive=3600)

# ======================
# STREAMING UPLOAD ENDPOINT
# ======================
@app.post("/api/features/upload-zip-stream")
async def upload_zip_stream(
    request: Request,
    zip_file: UploadFile = File(..., description="ZIP file with images")
):
    """
    ZIP upload with real-time progress streaming (SSE).
    Streams progress events for each image processed.

    SSE Events:
    - event: start - Upload received
    - event: init - File info (total images, size)
    - event: progress - Current image being processed (current, total, percent)
    - event: result - GPS data for processed image
    - event: complete - Final results with all GPS data
    - event: error - Error message
    """
    import zipfile
    import tempfile
    import shutil
    import json
    from functions import dms_to_decimal, snap_to_road
    from concurrent.futures import ThreadPoolExecutor
    import asyncio
    import io

    async def event_stream():
        """Stream SSE events"""
        try:
            # Get file size first
            await zip_file.seek(0, 2)
            total_size = await zip_file.tell()
            await zip_file.seek(0)

            total_mb = round(total_size / (1024 * 1024), 2)

            # Send file info immediately
            yield f"event: file_info\ndata: {json.dumps({'size_mb': total_mb, 'filename': zip_file.filename})}\n\n"
            await asyncio.sleep(0)

            # Setup temp directory
            temp_dir = tempfile.mkdtemp(dir=CUSTOM_TEMP_ROOT)
            # Sanitize client-controlled filename to prevent path traversal
            safe_filename = sanitize_filename(zip_file.filename)
            zip_temp_path = os.path.join(temp_dir, safe_filename)

            # Stream to disk in fixed-size chunks - never buffer the whole
            # file in memory (ZIPs can be multi-GB and would OOM the server).
            file_size = 0
            chunk_size = 1024 * 1024  # 1MB chunks

            with open(zip_temp_path, 'wb') as f:
                while chunk := await zip_file.read(chunk_size):
                    f.write(chunk)
                    file_size += len(chunk)
                    saved_mb = round(file_size / (1024 * 1024), 1)
                    percent = round((file_size / total_size) * 100, 1) if total_size else 100.0

                    # Send upload progress
                    yield f"event: upload_progress\ndata: {json.dumps({'current_mb': saved_mb, 'total_mb': total_mb, 'percent': percent})}\n\n"
                    await asyncio.sleep(0)

            # Upload complete, start processing
            yield f"event: start\ndata: {json.dumps({'message': 'Processing file...'})}\n\n"
            await asyncio.sleep(0)

            # Send init event
            yield f"event: init\ndata: {json.dumps({'size_mb': total_mb, 'filename': zip_file.filename})}\n\n"
            await asyncio.sleep(0)

            # Extract and process images
            image_extensions = ('.png', '.jpg', '.jpeg', '.bmp', '.gif')

            with zipfile.ZipFile(zip_temp_path, 'r') as zip_ref:
            # Get all image files
                image_files = [
                    m for m in zip_ref.namelist()
                    if m.lower().endswith(image_extensions) and not m.startswith('__MACOSX')
                ]
                image_files.sort()
                
                total_images = len(image_files)
                
                # Send count event
                yield f"event: count\ndata: {json.dumps({'total': total_images, 'size_mb': total_mb})}\n\n"
                await asyncio.sleep(0)  # Force immediate flush

                logger.info(f"Found {total_images} images in ZIP")

                # Extract all images first (faster than one-by-one)
                logger.info("Extracting all images...")
                extracted_paths = []
                for idx, member in enumerate(image_files, 1):
                    try:
                        extracted_path = zip_ref.extract(member, temp_dir)
                        extracted_paths.append((idx, extracted_path))
                    except Exception as e:
                        logger.warning(f"Error extracting image {idx}: {str(e)}")

            logger.info(f"Extracted {len(extracted_paths)} images, starting GPS extraction...")

            # Setup environment for exiftool
            env = os.environ.copy()
            env['TMPDIR'] = temp_dir
            env['EXIFTOOL_TMP'] = temp_dir

            # Process each image with progress
            results = []
            for idx, extracted_path in extracted_paths:
                    try:
                        # Calculate progress
                        progress = round((idx / total_images) * 100, 1)

                        # Send progress event
                        yield f"event: progress\ndata: {json.dumps({'current': idx, 'total': total_images, 'percent': progress})}\n\n"
                        await asyncio.sleep(0)  # Force immediate flush

                        # Extract GPS using exiftool
                        result = subprocess.run(
                            ['exiftool', '-GPSLatitude', '-GPSLongitude',
                                '-GPSLatitudeRef', '-GPSLongitudeRef',
                                extracted_path],
                            capture_output=True,
                            text=True,
                            env=env,
                            timeout=10
                        )

                        metadata = result.stdout.split('\n')
                        lat = lon = None
                        lat_ref = lon_ref = ''

                        for line in metadata:
                            if 'GPS Latitude' in line and 'Ref' not in line:
                                try:
                                    lat = dms_to_decimal(line.split(':', 1)[1].strip())
                                except:
                                    pass
                            elif 'GPS Longitude' in line and 'Ref' not in line:
                                try:
                                    lon = dms_to_decimal(line.split(':', 1)[1].strip())
                                except:
                                    pass
                            elif 'GPS Latitude Ref' in line:
                                lat_ref = line.split(':', 1)[1].strip()
                            elif 'GPS Longitude Ref' in line:
                                lon_ref = line.split(':', 1)[1].strip()

                        # Apply refs
                        if lat and lat_ref == 'S':
                            lat = -lat
                        if lon and lon_ref == 'W':
                            lon = -lon

                        # Add result
                        if lat and lon:
                            result_data = {
                                "name": str(idx),
                                "latitude": round(lat, 6),
                                "longitude": round(lon, 6)
                            }

                            results.append(result_data)

                            # Send result event
                            yield f"event: result\ndata: {json.dumps({'progress': progress, 'result': result_data})}\n\n"
                            await asyncio.sleep(0)  # Force immediate flush

                    except Exception as e:
                        logger.warning(f"Error processing image {idx}: {str(e)}")
                        continue

            gps_count = len(results)
            total_count = len(image_files)

            logger.info(f"Successfully extracted {gps_count} GPS coordinates from {total_count} images")
            logger.info(f"Temp files preserved at: {temp_dir}")
            
            # Send complete event
            yield f"event: complete\ndata: {json.dumps({'data': results, 'count': gps_count, 'gps_count': gps_count, 'total_images': total_count})}\n\n"
            await asyncio.sleep(0)  # Force immediate flush

        except Exception as e:
            logger.error(f"Error in stream processing: {str(e)}", exc_info=True)
            logger.info(f"Temp files preserved at: {temp_dir}")

            # Send error event
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"
            await asyncio.sleep(0)  # Force immediate flush

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


# ---------------------------------------------------------------------------
# Street View-style timeline: capture dates covering a point
# ---------------------------------------------------------------------------

@app.get("/api/timeline")
def get_timeline(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    radius: float = Query(25.0, ge=5.0, le=150.0),
):
    """Capture dates covering a point (Street View-style timeline).

    Returns one entry per capture DAY with the frame closest to (lat, lng)
    for that day: pick a date -> land on the nearest image of that date.
    Sorted latest-first so the newest capture is always first.
    """
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                WITH near AS (
                    SELECT feature_id,
                           capture_date,
                           image_url_comp,
                           latitude_snapped, longitude_snapped,
                           ST_Distance(
                               geom,
                               ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                           ) AS dist_m,
                           COUNT(*) OVER (
                               PARTITION BY capture_date::date
                           ) AS day_count
                    FROM image_features_4
                    WHERE is_deleted = FALSE
                      AND capture_date IS NOT NULL
                      AND geom IS NOT NULL
                      AND ST_DWithin(
                              geom,
                              ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                              %s
                          )
                )
                SELECT DISTINCT ON (capture_date::date)
                       capture_date::date  AS day,
                       day_count,
                       feature_id,
                       dist_m,
                       image_url_comp,
                       latitude_snapped, longitude_snapped
                FROM near
                ORDER BY capture_date::date ASC, dist_m ASC
                """,
                (lng, lat, lng, lat, radius),
            )
            rows = cursor.fetchall()
    except Exception as e:
        logger.error(f"Timeline query failed for ({lat},{lng}): {e}")
        raise HTTPException(status_code=500, detail="Timeline query failed")
    finally:
        conn.close()

    def fmt_day(d):
        return d.strftime("%B %d, %Y") if d else ""

    dates = []
    for (day, day_count, fid, dist_m, comp, lat_s, lon_s) in rows:
        dates.append(
            {
                "date": day.isoformat(),
                "label": fmt_day(day),
                "count": int(day_count),
                "latest": False,  # set below on the newest entry
                "nearest": {
                    "feature_id": fid,
                    "dist_m": round(float(dist_m), 1) if dist_m is not None else None,
                    "lat": float(lat_s) if lat_s is not None else None,
                    "lon": float(lon_s) if lon_s is not None else None,
                    "image_url_comp": comp,
                },
            }
        )
    dates.sort(key=lambda d: d["date"], reverse=True)
    if dates:
        dates[0]["latest"] = True

    body = {
        "status": "success",
        "lat": lat,
        "lng": lng,
        "radius": radius,
        "dates": dates,
    }
    etag = 'W/"tl-' + hashlib.md5(
        json.dumps([d["date"] for d in dates]).encode()
    ).hexdigest()[:12] + '"'
    return JSONResponse(
        content=body,
        headers={
            "ETag": etag,
            "Cache-Control": "public, max-age=300",
        },
    )


# ---------------------------------------------------------------------------
# Track manifest + single-feature lookup (client prefetching / navigation)
# ---------------------------------------------------------------------------

@app.get("/api/tracks/{track_number}/manifest")
def get_track_manifest(
    track_number: str,
    include: str = Query("ids", pattern="^(ids|urls)$"),
):
    """Ordered per-track image manifest for client-side prefetching.

    Compact by default: each sequence entry is [seq, feature_id, lat, lon,
    initial_yaw] — URLs are convention-derivable client-side. Pass
    `?include=urls` to embed the stored [image_url_comp, image_url_high]
    after the yaw field.
    """
    if not re.fullmatch(r"\d+", track_number or ""):
        raise HTTPException(status_code=400, detail="Invalid track number")
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT feature_id,
                       latitude_snapped, longitude_snapped,
                       COALESCE(initial_yaw, 0),
                       image_url_comp, image_url_high
                FROM image_features_4
                WHERE feature_id LIKE %s ESCAPE '\\' AND is_deleted = FALSE
                ORDER BY CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)
                """,
                (f"{track_number}\\_%",),
            )
            rows = cursor.fetchall()
    except Exception as e:
        logger.error(f"Manifest query failed for track {track_number}: {e}")
        raise HTTPException(status_code=500, detail="Manifest query failed")
    finally:
        conn.close()

    with_urls = include == "urls"
    sequence = []
    for (fid, lat, lon, yaw, comp, high) in rows:
        try:
            seq_num = int(fid.split("_", 1)[1])
        except (IndexError, ValueError):
            seq_num = 0
        entry = [
            seq_num,
            fid,
            round(lat, 7) if lat is not None else None,
            round(lon, 7) if lon is not None else None,
            round(yaw, 2) if yaw is not None else 0,
        ]
        if with_urls:
            entry += [comp, high]
        sequence.append(entry)

    body = {
        "status": "success",
        "track": int(track_number),
        "count": len(sequence),
        "sequence": sequence,
    }
    last_id = sequence[-1][1] if sequence else "empty"
    return JSONResponse(
        content=body,
        headers={
            "ETag": f'W/"track{track_number}-{len(sequence)}-{last_id}"',
            "Cache-Control": "public, max-age=3600",
        },
    )


@app.post("/api/metrics/perf")
async def post_perf_metrics(request: Request):
    """Fire-and-forget client performance beacons (sampled client-side).

    No auth by design — payloads carry only timings/hosts. Logged to the
    standard log sink; swap in a table later if queryability is needed.
    """
    try:
        body = await request.json()
        logger.info(f"[perf] {json.dumps(body)[:2000]}")
    except Exception as e:
        logger.warning(f"[perf] bad payload: {e}")
    return {"status": "ok"}
