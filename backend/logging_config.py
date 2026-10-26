"""
Enhanced Logging Configuration for Third Eye 360 API
Provides structured logging with rotation, separate error logs, and request tracking
"""
import logging
import logging.handlers
import os
import sys
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict
import traceback

from config import Config


class JSONFormatter(logging.Formatter):
    """Custom JSON formatter for structured logging"""
    
    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON"""
        log_data = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
        }
        
        # Add extra fields if present
        if hasattr(record, 'request_id'):
            log_data['request_id'] = record.request_id
        if hasattr(record, 'user_ip'):
            log_data['user_ip'] = record.user_ip
        if hasattr(record, 'endpoint'):
            log_data['endpoint'] = record.endpoint
        if hasattr(record, 'method'):
            log_data['method'] = record.method
        if hasattr(record, 'duration'):
            log_data['duration_ms'] = record.duration
        
        # Add exception info if present
        if record.exc_info:
            log_data['exception'] = {
                'type': record.exc_info[0].__name__,
                'message': str(record.exc_info[1]),
                'traceback': traceback.format_exception(*record.exc_info)
            }
        
        return json.dumps(log_data, default=str)


class ColoredConsoleFormatter(logging.Formatter):
    """Colored formatter for console output"""
    
    # ANSI color codes
    COLORS = {
        'DEBUG': '\033[36m',      # Cyan
        'INFO': '\033[32m',       # Green
        'WARNING': '\033[33m',    # Yellow
        'ERROR': '\033[31m',      # Red
        'CRITICAL': '\033[35m',   # Magenta
        'RESET': '\033[0m'        # Reset
    }
    
    def format(self, record: logging.LogRecord) -> str:
        """Format with colors for console"""
        color = self.COLORS.get(record.levelname, self.COLORS['RESET'])
        reset = self.COLORS['RESET']
        
        # Format timestamp
        timestamp = datetime.fromtimestamp(record.created).strftime('%Y-%m-%d %H:%M:%S')
        
        # Build log line
        log_line = (
            f"{color}[{record.levelname}]{reset} "
            f"{timestamp} - "
            f"{record.name} - "
            f"{record.getMessage()}"
        )
        
        # Add exception if present
        if record.exc_info:
            log_line += f"\n{self.formatException(record.exc_info)}"
        
        return log_line


def setup_logging(
    log_dir: str = None,
    log_level: str = "INFO",
    enable_json: bool = True,
    enable_console: bool = True,
    max_bytes: int = 10 * 1024 * 1024,  # 10MB
    backup_count: int = 30,
    enable_request_logging: bool = True
):
    """
    Setup comprehensive logging configuration
    
    Args:
        log_dir: Directory for log files (default: ./logs)
        log_level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        enable_json: Enable JSON formatted file logs
        enable_console: Enable console output
        max_bytes: Maximum size of each log file before rotation
        backup_count: Number of backup files to keep
        enable_request_logging: Enable request/response logging
    """
    
    # Create log directory
    if log_dir is None:
        log_dir = os.path.join(Config.BASE_DIR, "logs")
    
    log_path = Path(log_dir)
    log_path.mkdir(parents=True, exist_ok=True)
    
    # Create archived subdirectory
    archive_path = log_path / "archived"
    archive_path.mkdir(exist_ok=True)
    
    # Convert log level string to logging constant
    numeric_level = getattr(logging, log_level.upper(), logging.INFO)
    
    # Remove existing handlers to avoid duplicates
    root_logger = logging.getLogger()
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)
    
    # Set root logger level
    root_logger.setLevel(numeric_level)
    
    # ==========================================
    # 1. CONSOLE HANDLER (colored, human-readable)
    # ==========================================
    if enable_console:
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(numeric_level)
        console_formatter = ColoredConsoleFormatter()
        console_handler.setFormatter(console_formatter)
        root_logger.addHandler(console_handler)
    
    # ==========================================
    # 2. MAIN APPLICATION LOG (rotating, all levels)
    # ==========================================
    app_log_file = log_path / "api_app.log"
    app_handler = logging.handlers.RotatingFileHandler(
        filename=app_log_file,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding='utf-8'
    )
    app_handler.setLevel(numeric_level)
    
    if enable_json:
        app_handler.setFormatter(JSONFormatter())
    else:
        app_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        app_handler.setFormatter(app_formatter)
    
    root_logger.addHandler(app_handler)
    
    # ==========================================
    # 3. ERROR LOG (errors and critical only)
    # ==========================================
    error_log_file = log_path / "api_error.log"
    error_handler = logging.handlers.RotatingFileHandler(
        filename=error_log_file,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding='utf-8'
    )
    error_handler.setLevel(logging.ERROR)
    
    if enable_json:
        error_handler.setFormatter(JSONFormatter())
    else:
        error_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(pathname)s:%(lineno)d - %(message)s\n%(exc_info)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        error_handler.setFormatter(error_formatter)
    
    root_logger.addHandler(error_handler)
    
    # ==========================================
    # 4. ACCESS LOG (API requests/responses)
    # ==========================================
    if enable_request_logging:
        access_log_file = log_path / "api_access.log"
        access_handler = logging.handlers.RotatingFileHandler(
            filename=access_log_file,
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding='utf-8'
        )
        access_handler.setLevel(logging.INFO)
        
        if enable_json:
            access_handler.setFormatter(JSONFormatter())
        else:
            access_formatter = logging.Formatter(
                '%(asctime)s - %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )
            access_handler.setFormatter(access_formatter)
        
        # Create separate logger for access logs
        access_logger = logging.getLogger("api.access")
        access_logger.setLevel(logging.INFO)
        access_logger.addHandler(access_handler)
        access_logger.propagate = False
    
    # ==========================================
    # 5. TRACK OPERATIONS LOG (upload/processing)
    # ==========================================
    track_log_file = log_path / "track_operations.log"
    track_handler = logging.handlers.RotatingFileHandler(
        filename=track_log_file,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding='utf-8'
    )
    track_handler.setLevel(logging.INFO)
    
    if enable_json:
        track_handler.setFormatter(JSONFormatter())
    else:
        track_formatter = logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        track_handler.setFormatter(track_formatter)
    
    # Create separate logger for track operations
    track_logger = logging.getLogger("api.tracks")
    track_logger.setLevel(logging.INFO)
    track_logger.addHandler(track_handler)
    track_logger.propagate = False
    
    # ==========================================
    # 6. DATABASE LOG (queries and operations)
    # ==========================================
    db_log_file = log_path / "database.log"
    db_handler = logging.handlers.RotatingFileHandler(
        filename=db_log_file,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding='utf-8'
    )
    db_handler.setLevel(logging.INFO)
    
    if enable_json:
        db_handler.setFormatter(JSONFormatter())
    else:
        db_formatter = logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        db_handler.setFormatter(db_formatter)
    
    # Create separate logger for database operations
    db_logger = logging.getLogger("api.database")
    db_logger.setLevel(logging.INFO)
    db_logger.addHandler(db_handler)
    db_logger.propagate = False
    
    # ==========================================
    # 7. UPLOAD & PROCESSING LOG (file uploads and processing)
    # ==========================================
    upload_log_file = log_path / "upload_process.log"
    upload_handler = logging.handlers.RotatingFileHandler(
        filename=upload_log_file,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding='utf-8'
    )
    upload_handler.setLevel(logging.INFO)
    
    if enable_json:
        upload_handler.setFormatter(JSONFormatter())
    else:
        upload_formatter = logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        upload_handler.setFormatter(upload_formatter)
    
    # Create separate logger for upload and processing operations
    upload_logger = logging.getLogger("api.upload")
    upload_logger.setLevel(logging.INFO)
    upload_logger.addHandler(upload_handler)
    upload_logger.propagate = False
    
    # Log startup message
    root_logger.info("=" * 80)
    root_logger.info("Third Eye 360 API - Logging System Initialized")
    root_logger.info(f"Log Directory: {log_path}")
    root_logger.info(f"Log Level: {log_level}")
    root_logger.info(f"JSON Formatting: {enable_json}")
    root_logger.info(f"Max Log Size: {max_bytes / 1024 / 1024:.1f} MB")
    root_logger.info(f"Backup Count: {backup_count}")
    root_logger.info("=" * 80)


# Convenience functions for specialized loggers
def get_access_logger():
    """Get logger for API access logs"""
    return logging.getLogger("api.access")


def get_track_logger():
    """Get logger for track operations"""
    return logging.getLogger("api.tracks")


def get_db_logger():
    """Get logger for database operations"""
    return logging.getLogger("api.database")


def get_upload_logger():
    """Get logger for upload and processing operations"""
    return logging.getLogger("api.upload")


def log_request(method: str, endpoint: str, status_code: int, duration_ms: float, 
                user_ip: str = None, request_id: str = None):
    """
    Log API request with structured data
    
    Args:
        method: HTTP method (GET, POST, etc.)
        endpoint: API endpoint path
        status_code: HTTP status code
        duration_ms: Request duration in milliseconds
        user_ip: Client IP address
        request_id: Unique request ID
    """
    access_logger = get_access_logger()
    
    log_data = {
        'method': method,
        'endpoint': endpoint,
        'status_code': status_code,
        'duration_ms': duration_ms,
    }
    
    if user_ip:
        log_data['user_ip'] = user_ip
    if request_id:
        log_data['request_id'] = request_id
    
    message = f"{method} {endpoint} - {status_code} - {duration_ms:.2f}ms"
    
    # Create log record with extra fields
    extra = {
        'request_id': request_id,
        'user_ip': user_ip,
        'endpoint': endpoint,
        'method': method,
        'duration': duration_ms
    }
    
    access_logger.info(message, extra=extra)


def log_track_operation(operation: str, track_name: str, details: Dict[str, Any] = None):
    """
    Log track operation (upload, processing, etc.)
    
    Args:
        operation: Operation type (upload, process, delete, etc.)
        track_name: Track folder name
        details: Additional operation details
    """
    track_logger = get_track_logger()
    
    message = f"Track Operation: {operation} - {track_name}"
    if details:
        message += f" - {details}"
    
    track_logger.info(message)


def log_db_operation(operation: str, table: str, duration_ms: float = None, 
                     rows_affected: int = None, error: str = None):
    """
    Log database operation
    
    Args:
        operation: SQL operation (SELECT, INSERT, UPDATE, DELETE)
        table: Table name
        duration_ms: Query duration in milliseconds
        rows_affected: Number of rows affected
        error: Error message if operation failed
    """
    db_logger = get_db_logger()
    
    message = f"DB {operation} on {table}"
    
    if duration_ms:
        message += f" - {duration_ms:.2f}ms"
    if rows_affected is not None:
        message += f" - {rows_affected} rows"
    
    if error:
        db_logger.error(f"{message} - ERROR: {error}")
    else:
        db_logger.info(message)


def log_upload_start(upload_id: str, file_name: str, file_size: int = None, user_info: Dict[str, Any] = None):
    """
    Log start of file upload
    
    Args:
        upload_id: Unique upload identifier
        file_name: Name of uploaded file
        file_size: Size of file in bytes
        user_info: Additional user/request information
    """
    upload_logger = get_upload_logger()
    
    message = f"Upload Started: {upload_id} - {file_name}"
    if file_size:
        message += f" - {file_size / 1024 / 1024:.2f} MB"
    if user_info:
        message += f" - User: {user_info}"
    
    upload_logger.info(message)


def log_upload_complete(upload_id: str, track_name: str, images_count: int, duration_ms: float = None):
    """
    Log successful completion of upload
    
    Args:
        upload_id: Unique upload identifier
        track_name: Track folder name
        images_count: Number of images uploaded
        duration_ms: Total processing time in milliseconds
    """
    upload_logger = get_upload_logger()
    
    message = f"Upload Complete: {upload_id} - Track: {track_name} - Images: {images_count}"
    if duration_ms:
        message += f" - Duration: {duration_ms / 1000:.2f}s"
    
    upload_logger.info(message)


def log_upload_error(upload_id: str, error_msg: str, exception: Exception = None):
    """
    Log upload failure
    
    Args:
        upload_id: Unique upload identifier
        error_msg: Error message
        exception: Exception object if available
    """
    upload_logger = get_upload_logger()
    
    message = f"Upload Failed: {upload_id} - {error_msg}"
    
    if exception:
        upload_logger.error(message, exc_info=True)
    else:
        upload_logger.error(message)


def log_processing_step(upload_id: str, step: str, status: str, details: Dict[str, Any] = None):
    """
    Log individual processing step
    
    Args:
        upload_id: Unique upload identifier
        step: Processing step name (unzip, blur, geojson, etc.)
        status: Step status (started, completed, failed)
        details: Additional step details
    """
    upload_logger = get_upload_logger()
    
    message = f"Processing {status}: {upload_id} - Step: {step}"
    if details:
        message += f" - {details}"
    
    if status == "failed":
        upload_logger.error(message)
    else:
        upload_logger.info(message)

