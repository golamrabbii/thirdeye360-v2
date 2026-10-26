"""
Request Logging Middleware for FastAPI
Tracks all API requests with unique IDs, timing, and detailed logging
"""
import time
import uuid
from typing import Callable
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from fastapi import FastAPI
import logging

from logging_config import log_request

logger = logging.getLogger(__name__)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """
    Middleware to log all API requests with timing and metadata
    """
    
    def __init__(self, app: FastAPI, enable_slow_query_warning: bool = True, slow_threshold_ms: float = 1000.0):
        """
        Initialize middleware
        
        Args:
            app: FastAPI application
            enable_slow_query_warning: Log warning for slow requests
            slow_threshold_ms: Threshold in ms to consider request as slow
        """
        super().__init__(app)
        self.enable_slow_query_warning = enable_slow_query_warning
        self.slow_threshold_ms = slow_threshold_ms
    
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Process request and log details"""

        # Generate unique request ID
        request_id = str(uuid.uuid4())

        # Add request ID to request state for use in endpoint handlers
        request.state.request_id = request_id

        # Get client IP (handle proxy headers)
        client_ip = request.client.host if request.client else "unknown"
        if "x-forwarded-for" in request.headers:
            client_ip = request.headers["x-forwarded-for"].split(",")[0].strip()
        elif "x-real-ip" in request.headers:
            client_ip = request.headers["x-real-ip"]

        # Get request details
        method = request.method
        endpoint = request.url.path
        query_params = str(request.query_params) if request.query_params else ""

        # Enhanced logging for upload requests
        is_upload_request = endpoint.endswith('/upload-zip') or endpoint.endswith('/upload-zip/')

        # Log request start with enhanced details for uploads
        if is_upload_request:
            logger.info(
                f"=== UPLOAD REQUEST START ===\n"
                f"Request ID: {request_id}\n"
                f"Method: {method}\n"
                f"Endpoint: {endpoint}\n"
                f"Client IP: {client_ip}\n"
                f"Content-Type: {request.headers.get('content-type', 'not-set')}\n"
                f"Content-Length: {request.headers.get('content-length', 'not-set')}\n"
                f"User-Agent: {request.headers.get('user-agent', 'not-set')}\n"
                f"============================"
            )

            # Force terminal output for upload requests
            print("\n" + "=" * 60)
            print(f"UPLOAD REQUEST STARTED - {request_id}")
            print("=" * 60)
            print(f"Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")
            print(f"Client: {client_ip}")
            print(f"Content-Type: {request.headers.get('content-type', 'not-set')}")
            print(f"Content-Length: {request.headers.get('content-length', 'not-set')}")
            print(f"User-Agent: {request.headers.get('user-agent', 'not-set')}")
            print("=" * 60 + "\n")
        else:
            logger.info(
                f"Request started: {request_id} - {method} {endpoint}",
                extra={
                    'request_id': request_id,
                    'user_ip': client_ip,
                    'endpoint': endpoint,
                    'method': method
                }
            )

        # Start timer
        start_time = time.time()

        # For upload requests, log that we're about to process
        if is_upload_request:
            print(f"[{request_id}] About to call next handler for upload request...")
            logger.info(f"[{request_id}] About to call next handler for upload request")

        # Process request
        try:
            print(f"[{request_id}] Calling next handler...")
            response = await call_next(request)
            print(f"[{request_id}] Handler returned response: {response.status_code}")

            # Calculate duration
            duration_ms = (time.time() - start_time) * 1000

            # Log request completion
            log_request(
                method=method,
                endpoint=endpoint,
                status_code=response.status_code,
                duration_ms=duration_ms,
                user_ip=client_ip,
                request_id=request_id
            )

            # Log upload request completion
            if is_upload_request:
                print(f"\n[{request_id}] UPLOAD REQUEST COMPLETED - Status: {response.status_code}, Duration: {duration_ms:.0f}ms\n")
                logger.info(f"[{request_id}] UPLOAD REQUEST COMPLETED - Status: {response.status_code}, Duration: {duration_ms:.0f}ms")

            # Log slow requests as warnings
            if self.enable_slow_query_warning and duration_ms > self.slow_threshold_ms:
                logger.warning(
                    f"Slow request detected: {method} {endpoint} took {duration_ms:.2f}ms",
                    extra={
                        'request_id': request_id,
                        'duration': duration_ms,
                        'endpoint': endpoint,
                        'method': method
                    }
                )

            # Add request ID to response headers
            response.headers["X-Request-ID"] = request_id

            return response

        except Exception as e:
            # Calculate duration even for failed requests
            duration_ms = (time.time() - start_time) * 1000

            # Enhanced error logging for upload requests
            if is_upload_request:
                logger.error(
                    f"=== UPLOAD REQUEST FAILED ===\n"
                    f"Request ID: {request_id}\n"
                    f"Method: {method}\n"
                    f"Endpoint: {endpoint}\n"
                    f"Client IP: {client_ip}\n"
                    f"Duration: {duration_ms:.2f}ms\n"
                    f"Exception Type: {type(e).__name__}\n"
                    f"Exception Message: {str(e)}\n"
                    f"Content-Type: {request.headers.get('content-type', 'not-set')}\n"
                    f"Content-Length: {request.headers.get('content-length', 'not-set')}\n"
                    f"============================",
                    exc_info=True  # This includes the full traceback
                )
            else:
                # Log error
                logger.error(
                    f"Request failed: {request_id} - {method} {endpoint} - {str(e)}",
                    exc_info=True,
                    extra={
                        'request_id': request_id,
                        'user_ip': client_ip,
                        'endpoint': endpoint,
                        'method': method,
                        'duration': duration_ms
                    }
                )

            # Re-raise exception to be handled by FastAPI
            raise


def setup_request_logging(app: FastAPI, slow_threshold_ms: float = 1000.0):
    """
    Setup request logging middleware
    
    Args:
        app: FastAPI application
        slow_threshold_ms: Threshold in ms to log slow requests
    """
    app.add_middleware(
        RequestLoggingMiddleware,
        enable_slow_query_warning=True,
        slow_threshold_ms=slow_threshold_ms
    )
    
    logger.info(f"Request logging middleware enabled (slow threshold: {slow_threshold_ms}ms)")
