# ThirdEye360 - 360° Image Processing System

## Overview

ThirdEye360 is a comprehensive system for processing, geotagging, and visualizing 360° images. It provides:

- Secure user authentication and management
- Bulk processing of 360° images from ZIP archives
- Automatic geotagging and road snapping using GPS data
- GeoJSON generation for visualization
- Database storage of image metadata
- Web-based interface for easy management

## Key Features

- **User Authentication**: Secure login system with password recovery
- **Image Processing**: 
  - Automatic extraction of GPS data from images
  - Road snapping using Barikoi API
  - Distance-based filtering of images
- **Data Management**:
  - PostgreSQL database storage
  - Track-based organization of images
  - GeoJSON generation for visualization
- **Performance**:
  - Parallel processing for efficient handling of large datasets
  - Custom temp directory configuration
  - Memory management controls

## System Requirements

- Python 3.10.12
- PostgreSQL 14
- Required Python packages (see `requirements.txt`)
- Minimum 4GB RAM (8GB recommended for large datasets)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/barikoi/third-eye-360.git
   cd third-eye-360

2. Create and activate a virtual environment:
   ```bash
    python -m venv venv
    source venv/bin/activate  # Linux/Mac
    venv\Scripts\activate     # Windows

3. Install dependencies:
   ```bash
   pip install -r requirements.txt

4. Run the application
   ```bash
   streamlit run app.py --server.port 8501 # Can change the port if required