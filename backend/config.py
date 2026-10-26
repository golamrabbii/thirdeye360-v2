import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    # Required credentials - will raise error if missing
    DB_NAME = os.environ['DB_NAME']
    DB_USER = os.environ['DB_USER']
    DB_PASSWORD = os.environ['DB_PASSWORD']
    DB_HOST = os.environ['DB_HOST']
    DB_PORT = os.environ['DB_PORT']
    BARIKOI_API_KEY = os.environ['BARIKOI_API_KEY']
    OPENAI_API_KEY = os.environ['OPENAI_API_KEY']
    TOGETHER_API_KEY = os.environ['TOGETHER_API_KEY']
    
    # Configuration with sensible defaults
    
    TEMP_ROOT = os.getenv('TEMP_ROOT', './all-tracks/tmp')
    BASE_DIR = os.getenv('BASE_DIR', './all-tracks')
    TILES_DIR = os.getenv('TILES_DIR', './all-tracks/tiledata')

    # API configuration
    API_IMAGE_URL = os.getenv('API_IMAGE_URL', '/api/images/')
    API_BASE_URL = os.getenv('API_BASE_URL', 'http://localhost:8001')

    MIN_DISTANCE_METERS = int(os.getenv('MIN_DISTANCE_METERS', '2'))
    
    # ==================== CLOUDFLARE R2 CONFIGURATION ====================
    # R2 API Credentials and Endpoints
    R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '')
    R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '')
    R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '')
    R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'third-eye-360-images')
    R2_ENDPOINT_URL = os.getenv('R2_ENDPOINT_URL', '')
    R2_PUBLIC_DOMAIN = os.getenv('R2_PUBLIC_DOMAIN', '')
    
    # Presigned URL Configuration
    R2_PRESIGNED_URL_EXPIRY = int(os.getenv('R2_PRESIGNED_URL_EXPIRY', '86400'))  # 24 hours

    # ---- r2-proxy disk cache (hot-image LRU) ----
    # 0 disables the cache entirely (pure streaming proxy — the default so
    # nothing is written to disk unless explicitly enabled). When set, the
    # first fetch of an image is written through to R2_PROXY_CACHE_DIR and
    # later hits are served straight from disk (fast path, Range/ETag).
    R2_PROXY_DISK_CACHE_GB = float(os.getenv('R2_PROXY_DISK_CACHE_GB', '0'))
    R2_PROXY_CACHE_DIR = os.getenv(
        'R2_PROXY_CACHE_DIR', os.path.join(BASE_DIR, 'r2_cache')
    )
    
    # Feature Flags for Gradual Migration
    USE_R2_URLS = os.getenv('USE_R2_URLS', 'true').lower() == 'true'
    FALLBACK_TO_LOCAL = os.getenv('FALLBACK_TO_LOCAL', 'true').lower() == 'true'
    MAX_BATCH_SIZE = int(os.getenv('MAX_BATCH_SIZE', '1100'))

    @classmethod
    def validate(cls):
        """Validate that required credentials are present"""
        required = [
            'DB_NAME', 'DB_USER', 'DB_PASSWORD',
            'DB_HOST', 'DB_PORT', 'BARIKOI_API_KEY'
        ]
        for var in required:
            if not getattr(cls, var):
                raise ValueError(f"Missing required environment variable: {var}")

# Validate configuration on import
Config.validate()