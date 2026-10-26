#!/usr/bin/env python3
"""
Standalone FastAPI Server Runner
Run this independently from Streamlit: python run_api.py
"""
import uvicorn
import logging
from api import app
from config import Config

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)

if __name__ == "__main__":
    import os as _os
    _port = int(_os.getenv("API_PORT", "8001"))
    logger.info("Starting FastAPI server independently...")
    logger.info(f"API will be available at: http://0.0.0.0:{_port}")
    logger.info(f"Base directory: {Config.BASE_DIR}")

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=_port,
        timeout_keep_alive=3600,
        log_level="info",
        access_log=True
    )
