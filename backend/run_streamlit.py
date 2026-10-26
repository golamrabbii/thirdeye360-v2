#!/usr/bin/env python3
"""
Standalone Streamlit Server Runner
Run this independently: python run_streamlit.py
"""
import subprocess
import sys
import os
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)

if __name__ == "__main__":
    # Set unlimited file upload size
    os.environ['STREAMLIT_SERVER_MAX_UPLOAD_SIZE'] = '999999'

    logger.info("Starting Streamlit server...")
    logger.info("Streamlit will be available at: http://0.0.0.0:8502")
    logger.info("Unlimited file upload size enabled (999999 MB)")

    try:
        subprocess.run([
            sys.executable, "-m", "streamlit", "run",
            "app.py",
            "--server.port=8502",
            "--server.address=0.0.0.0",
            "--server.headless=true"
        ], check=True)
    except KeyboardInterrupt:
        logger.info("Streamlit server stopped by user")
    except Exception as e:
        logger.error(f"Error running Streamlit: {e}")
        sys.exit(1)
