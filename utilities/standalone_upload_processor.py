#!/usr/bin/env python3
"""
Standalone ZIP Upload Processor - Streamlit Alternative

This script provides a complete alternative to Streamlit for ZIP file upload processing.
All steps are modularized as separate functions for better maintainability and debugging.

Requirements:
    - pip install psycopg2-binary requests Pillow

Usage:
    python standalone_upload_processor.py <zip_file_path> [min_distance]

Example:
    python standalone_upload_processor.py /path/to/images.zip 2.0
"""

import os
import sys
import zipfile
import tempfile
import shutil
import json
import logging
import argparse
import traceback
import math
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
import subprocess
import hashlib

# Configuration
class Config:
    BASE_DIR = "/home/barikoi/third-eye-360/backend"
    TEMP_ROOT = os.path.join(BASE_DIR, "temp_uploads")
    API_BASE_URL = "https://streetview.bmapsbd.com/api"
    BARIKOI_API_KEY = "bkoi_ed6171d88adc261e0a937a5649999a16fcbd8808c16f7fa08a9634cb6c41b944"  # Replace with actual API key
    MIN_DISTANCE_METERS = 2.0
    DB_NAME = "third_eye"
    DB_USER = "barikoidbadmin"
    DB_PASSWORD = "BK1fOI75hBKAynlujqRyDx"
    DB_HOST = "103.72.199.81"
    DB_PORT = "4352"

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('upload_processor.log')
    ]
)
logger = logging.getLogger(__name__)


# ============================================================================
# MODULE 1: File Management & ZIP Extraction
# ============================================================================

class FileManager:
    """Handles file operations and ZIP extraction"""

    def __init__(self, temp_root: str = None):
        self.temp_root = temp_root or Config.TEMP_ROOT
        self.temp_dir = None
        self.setup_temp_directories()

    def setup_temp_directories(self):
        """Setup temporary directories for processing"""
        os.makedirs(self.temp_root, exist_ok=True)
        self.temp_dir = tempfile.mkdtemp(dir=self.temp_root)
        logger.info(f"Created temp directory: {self.temp_dir}")

    def cleanup_temp_files(self):
        """Clean up temporary files and directories"""
        if self.temp_dir and os.path.exists(self.temp_dir):
            try:
                shutil.rmtree(self.temp_dir)
                logger.info(f"Cleaned up temp directory: {self.temp_dir}")
            except Exception as e:
                logger.error(f"Error cleaning up temp directory: {e}")

    def extract_zip(self, zip_path: str) -> List[str]:
        """Extract ZIP file and return list of extracted files"""
        logger.info(f"Extracting ZIP file: {zip_path}")
        extracted_files = []

        try:
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                # Get list of files
                file_list = zip_ref.namelist()
                image_extensions = ('.png', '.jpg', '.jpeg', '.bmp', '.gif')

                # Extract only image files
                for file in file_list:
                    if file.lower().endswith(image_extensions):
                        extract_path = zip_ref.extract(file, self.temp_dir)
                        extracted_files.append(extract_path)
                        logger.debug(f"Extracted: {file}")

            logger.info(f"Extracted {len(extracted_files)} image files")
            return extracted_files

        except Exception as e:
            logger.error(f"Error extracting ZIP file: {e}")
            raise

    def validate_zip(self, zip_path: str) -> bool:
        """Validate ZIP file integrity"""
        try:
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                # Test ZIP integrity
                bad_file = zip_ref.testzip()
                if bad_file:
                    logger.error(f"Bad file in ZIP: {bad_file}")
                    return False

                # Check for image files
                image_extensions = ('.png', '.jpg', '.jpeg', '.bmp', '.gif')
                image_files = [f for f in zip_ref.namelist()
                             if f.lower().endswith(image_extensions)]

                if not image_files:
                    logger.error("No image files found in ZIP")
                    return False

                logger.info(f"ZIP validation passed. Found {len(image_files)} images")
                return True

        except Exception as e:
            logger.error(f"ZIP validation error: {e}")
            return False


# ============================================================================
# MODULE 2: EXIF Data Extraction
# ============================================================================

class EXIFExtractor:
    """Extracts EXIF data from images"""

    def __init__(self, api_key: str = None):
        self.api_key = api_key or Config.BARIKOI_API_KEY

    def extract_image_metadata(self, image_path: str) -> Optional[Dict[str, Any]]:
        """Extract metadata from a single image"""
        try:
            logger.debug(f"Extracting metadata from: {image_path}")

            # Set up environment for subprocess
            env = os.environ.copy()
            env['TMPDIR'] = Config.TEMP_ROOT
            env['EXIFTOOL_TMP'] = Config.TEMP_ROOT

            result = subprocess.run(
                ['exiftool',
                 '-GPSLatitude', '-GPSLongitude',
                 '-GPSLatitudeRef', '-GPSLongitudeRef',
                 '-DateTimeOriginal',
                 '-PosePitchDegrees', '-FocalLength',
                 image_path],
                capture_output=True,
                text=True,
                env=env,
                check=True
            )

            metadata = result.stdout.split('\n')

            # Debug: Log first few lines of exiftool output
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug(f"ExifTool output for {os.path.basename(image_path)}:")
                for line in metadata[:8]:  # Log first 8 lines
                    if line.strip():
                        logger.debug(f"  {line}")

            parsed_data = self.parse_exif_data(metadata, image_path)

            # Debug: Log what we parsed
            if parsed_data:
                if parsed_data.get('has_gps'):
                    logger.debug(f"✅ GPS found: {os.path.basename(image_path)} - Lat: {parsed_data['lat']}, Lon: {parsed_data['lon']}")
                else:
                    logger.debug(f"⚠️  No GPS: {os.path.basename(image_path)}")
            else:
                logger.debug(f"❌ Parse failed: {os.path.basename(image_path)}")

            return parsed_data

        except subprocess.CalledProcessError as e:
            logger.warning(f"ExifTool error for {image_path}: {e}")
            if e.stdout:
                logger.warning(f"ExifTool stdout: {e.stdout}")
            if e.stderr:
                logger.warning(f"ExifTool stderr: {e.stderr}")
            return None
        except Exception as e:
            logger.error(f"Error extracting metadata from {image_path}: {e}")
            return None

    def parse_exif_data(self, metadata_lines: List[str], image_path: str) -> Optional[Dict[str, Any]]:
        """Parse EXIF data output from exiftool - allows partial data"""
        lat = lon = None
        lat_ref = lon_ref = ''
        capture_time = None
        pitch = None
        focal_length = None

        for line in metadata_lines:
            line = line.strip()
            if not line or ':' not in line:
                continue

            key, value = line.split(':', 1)
            key = key.strip().lower()  # Convert to lowercase for case-insensitive matching
            value = value.strip()

            # More flexible key matching
            if 'gps latitude' in key and 'ref' not in key:
                lat = self.dms_to_decimal(value)
            elif 'gps longitude' in key and 'ref' not in key:
                lon = self.dms_to_decimal(value)
            elif 'gps latitude ref' in key or 'gps latituderef' in key:
                lat_ref = value.upper()
            elif 'gps longitude ref' in key or 'gps longituderef' in key:
                lon_ref = value.upper()
            elif 'date/time original' in key or 'datetimeoriginal' in key:
                try:
                    capture_time = datetime.strptime(value, '%Y:%m:%d %H:%M:%S')
                except ValueError:
                    pass
            elif 'pose pitch degrees' in key or 'posepitchdegrees' in key:
                try:
                    pitch = float(value)
                except ValueError:
                    pass
            elif 'focal length' in key or 'focallength' in key:
                try:
                    focal_length = float(value.split()[0])
                except (ValueError, IndexError):
                    pass

        # Debug logging for parsing results
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(f"Parsed GPS data for {os.path.basename(image_path)}:")
            logger.debug(f"  Raw lat: {lat}, lon: {lon}")
            logger.debug(f"  Refs: lat={lat_ref}, lon={lon_ref}")
            logger.debug(f"  Time: {capture_time}")

        # Return data even without GPS - NO DATA LOSS
        # Only require timestamp for basic processing
        if not capture_time:
            logger.warning(f"⚠️  SKIPPED: {os.path.basename(image_path)} - No timestamp found")
            return None

        # Apply GPS references if coordinates exist
        if lat and lon:
            if lat_ref == 'S':
                lat = -lat
            if lon_ref == 'W':
                lon = -lon
            logger.debug(f"  Applied refs: {lat}, {lon}")

        # Log missing GPS but still process the image
        if not (lat and lon):
            logger.info(f"ℹ️  NO GPS: {os.path.basename(image_path)} - Will process without location")

        return {
            'path': image_path,
            'filename': os.path.basename(image_path),
            'lat': lat,
            'lon': lon,
            'time': capture_time,
            'pitch': pitch,
            'focal_length': focal_length,
            'has_gps': bool(lat and lon)  # Flag to track GPS availability
        }

    def dms_to_decimal(self, dms_string: str) -> Optional[float]:
        """Convert DMS (Degrees Minutes Seconds) to decimal degrees"""
        if not dms_string:
            return None

        try:
            # Handle various DMS formats:
            # "23 45 30.5" (space separated)
            # "23° 45' 30.5\"" (with symbols)
            # "23,45,30.5" (comma separated)
            # "23 deg 45' 30\"" (with text)

            # Remove common symbols and text
            cleaned = dms_string.replace('°', ' ').replace("'", ' ').replace('"', ' ')
            cleaned = cleaned.replace('deg', ' ').replace(' ', ' ').strip()

            # Try space-separated first
            parts = cleaned.split()
            if len(parts) >= 3:
                degrees = float(parts[0])
                minutes = float(parts[1])
                seconds = float(parts[2])

                decimal = degrees + (minutes / 60) + (seconds / 3600)
                logger.debug(f"DMS conversion: {dms_string} → {decimal:.6f}")
                return decimal

            # Try comma-separated
            parts = dms_string.split(',')
            if len(parts) >= 3:
                degrees = float(parts[0])
                minutes = float(parts[1])
                seconds = float(parts[2])

                decimal = degrees + (minutes / 60) + (seconds / 3600)
                logger.debug(f"DMS conversion: {dms_string} → {decimal:.6f}")
                return decimal

            logger.debug(f"DMS conversion failed for: {dms_string}")
            return None

        except (ValueError, IndexError) as e:
            logger.debug(f"DMS conversion error for '{dms_string}': {e}")
            return None


# ============================================================================
# MODULE 3: GPS Processing & Snap to Road
# ============================================================================

class GPSProcessor:
    """Processes GPS data and snaps to roads"""

    def __init__(self, api_key: str = None):
        self.api_key = api_key or Config.BARIKOI_API_KEY

    def snap_to_road(self, lat: float, lon: float) -> Optional[Dict[str, float]]:
        """Snap GPS coordinates to road using Barikoi API"""
        try:
            import requests

            # Correct API endpoint for snap to road
            url = "https://barikoi.xyz/v2/api/routing/nearest"
            params = {
                'point': f"{lat},{lon}",
                'api_key': self.api_key
            }

            logger.debug(f"Snap to road API call: {lat}, {lon}")

            response = requests.get(url, params=params, timeout=10)

            if response.status_code == 200:
                data = response.json()
                logger.debug(f"Snap to road API response: {data}")

                # Parse the response according to the correct format
                if 'coordinates' in data and len(data['coordinates']) >= 2:
                    snapped_coords = data['coordinates']
                    return {
                        'latitude': float(snapped_coords[1]),  # Latitude is second
                        'longitude': float(snapped_coords[0]),  # Longitude is first
                        'distance': data.get('distance', 0)
                    }
            else:
                logger.warning(f"Snap to road API error: {response.status_code}")

            return None

        except Exception as e:
            logger.error(f"Error snapping to road: {e}")
            return None

    def process_coordinates(self, image_data: Dict[str, Any]) -> Dict[str, Any]:
        """Process and snap coordinates for a single image - handles missing GPS"""
        lat = image_data['lat']
        lon = image_data['lon']

        # If no GPS data, skip snap-to-road but keep processing
        if not (lat and lon):
            image_data['snapped_lat'] = None
            image_data['snapped_lon'] = None
            image_data['address'] = None
            logger.debug(f"No GPS for {image_data['filename']} - skipping snap-to-road")
            return image_data

        # Try to snap to road only if GPS exists
        snapped = self.snap_to_road(lat, lon)
        if snapped:
            image_data['snapped_lat'] = snapped['latitude']
            image_data['snapped_lon'] = snapped['longitude']
            image_data['address'] = snapped.get('address', '')
            logger.debug(f"Snapped coordinates: {lat}, {lon} -> {snapped['latitude']}, {snapped['longitude']}")
        else:
            # Keep original coordinates if snapping fails
            image_data['snapped_lat'] = lat
            image_data['snapped_lon'] = lon
            image_data['address'] = ''

        return image_data


# ============================================================================
# MODULE 4: Image Grouping & Track Creation
# ============================================================================

class ImageGrouper:
    """Groups images by time gaps and creates tracks"""

    def __init__(self, gap_minutes: int = 1):
        self.gap_minutes = gap_minutes

    def group_images_by_time_gap(self, images_data: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
        """Group images based on time gaps"""
        if not images_data:
            return []

        # Sort by capture time
        sorted_images = sorted(images_data, key=lambda x: x['time'])

        groups = []
        current_group = [sorted_images[0]]

        for i in range(1, len(sorted_images)):
            current_time = sorted_images[i]['time']
            prev_time = current_group[-1]['time']

            # Calculate time difference in minutes
            time_diff = (current_time - prev_time).total_seconds() / 60

            if time_diff > self.gap_minutes:
                # Start new group
                groups.append(current_group)
                current_group = [sorted_images[i]]
            else:
                # Add to current group
                current_group.append(sorted_images[i])

        # Add last group
        if current_group:
            groups.append(current_group)

        logger.info(f"Grouped {len(sorted_images)} images into {len(groups)} tracks")
        return groups

    def get_next_track_number(self, base_dir: str, db_manager = None) -> int:
        """
        Get the next available track number from database (like Streamlit)
        Falls back to file system if DB unavailable
        """
        # Try to get from database first (like Streamlit)
        if db_manager and db_manager.conn:
            try:
                cursor = db_manager.conn.cursor()

                # Get max track number from database
                cursor.execute("""
                    SELECT MAX(CAST(SUBSTRING(feature_id FROM '^([0-9]+)_') AS INTEGER))
                    FROM image_features_4
                    WHERE feature_id ~ '^[0-9]+_[0-9]+$'
                """)

                result = cursor.fetchone()
                if result and result[0]:
                    next_track = result[0] + 1
                    logger.info(f"Next track number from database: {next_track}")
                    return next_track

            except Exception as e:
                logger.warning(f"Could not get track number from DB: {e}")
                # Fall through to file system method

        # Fallback: Check file system
        track_folders = []
        try:
            if os.path.exists(base_dir):
                for item in os.listdir(base_dir):
                    if item.startswith('track') and os.path.isdir(os.path.join(base_dir, item)):
                        try:
                            track_num = int(item.replace('track', ''))
                            track_folders.append(track_num)
                        except ValueError:
                            continue

                if track_folders:
                    next_track = max(track_folders) + 1
                    logger.info(f"Next track number from file system: {next_track}")
                    return next_track

            # Default to track 0 if no tracks found
            logger.info("No existing tracks found, starting from track 0")
            return 0

        except Exception as e:
            logger.error(f"Error getting next track number: {e}")
            return 0

    def generate_feature_id(self, track_number: int, image_sequence: int) -> str:
        """
        Generate feature ID in format: trackNumber_imageSequence
        Example: "3499_1" (NOT "track3499_1")

        Args:
            track_number: Track number (e.g., 3499)
            image_sequence: Sequential image number (e.g., 1)

        Returns:
            Feature ID string like "3499_1"
        """
        return f"{track_number}_{image_sequence}"


# ============================================================================
# MODULE 5: Track Folder Management
# ============================================================================

class TrackManager:
    """Manages track folders and image organization"""

    def __init__(self, base_dir: str):
        self.base_dir = base_dir

    def create_track_folder(self, track_number: int) -> str:
        """Create a new track folder"""
        track_folder = os.path.join(self.base_dir, f"track{track_number}")
        os.makedirs(track_folder, exist_ok=True)
        logger.info(f"Created track folder: {track_folder}")
        return track_folder

    def copy_image_to_track(self, image_data: Dict[str, Any], track_folder: str, image_index: int, track_number: int):
        """Copy image to track folder with proper naming and compression"""
        import shutil

        src_path = image_data['path']
        filename = image_data['filename']
        track_name = os.path.basename(track_folder)

        # Create new filename: 3499_1.jpg (no prefixes)
        # track_number = 3499, image_index = 1 → 3499_1.jpg
        new_filename = f"{track_number}_{image_index}.jpg"
        dst_path = os.path.join(track_folder, new_filename)

        shutil.copy2(src_path, dst_path)
        logger.debug(f"Copied {filename} -> {new_filename}")

        # Create compressed version: 3499_1_comp.jpg
        try:
            comp_filename = f"{track_number}_{image_index}_comp.jpg"
            comp_path = os.path.join(track_folder, comp_filename)

            # Compress image
            from PIL import Image
            img = Image.open(dst_path)

            # Start with quality 95 and reduce until under 100KB
            quality = 95
            while quality > 10:
                img.save(comp_path, 'JPEG', quality=quality, optimize=True)

                # Check file size
                file_size_kb = os.path.getsize(comp_path) / 1024

                if file_size_kb <= 100:  # Target: ~100KB
                    logger.debug(f"Compressed: {new_filename} -> {comp_filename} ({file_size_kb:.1f}KB)")
                    break

                quality -= 5
            else:
                logger.warning(f"Could not compress {new_filename} to target size")

        except Exception as e:
            logger.error(f"Error compressing image {new_filename}: {e}")

        return new_filename


# ============================================================================
# MODULE 6: GeoJSON Generation
# ============================================================================

class GeoJSONGenerator:
    """Generates GeoJSON files for tracks"""

    def __init__(self, base_url: str = None, image_grouper = None):
        self.base_url = base_url or Config.API_BASE_URL
        self.image_grouper = image_grouper

    def create_geojson(self, track_folder: str, images_data: List[Dict[str, Any]], track_number: int) -> str:
        """Create GeoJSON file for a track - handles images without GPS"""
        track_name = os.path.basename(track_folder)
        output_file = os.path.join(track_folder, "data.json")

        features = []
        no_gps_count = 0

        for idx, img_data in enumerate(images_data, 1):
            # Use snapped coordinates if available
            lat = img_data.get('snapped_lat')
            lon = img_data.get('snapped_lon')

            # Create image URL - matches actual file naming: 3499_1.jpg
            # No prefixes, just: trackNumber_imageIndex
            image_filename = f"{track_number}_{idx}.jpg"
            image_url_high = f"{self.base_url}/{track_name}/{image_filename}"
            image_url_comp = f"{self.base_url}/{track_name}/{track_number}_{idx}_comp.jpg"

            # Get pitch if available
            pitch = img_data.get('pitch', 0) if img_data.get('pitch') is not None else 0
            hfov = self.calculate_hfov(img_data.get('focal_length'))

            # Check if image has GPS
            has_gps = img_data.get('has_gps', bool(lat and lon))

            # Generate feature ID: "3499_1" (NOT "track3499_1")
            feature_id = f"{track_number}_{idx}"

            if not has_gps:
                no_gps_count += 1
                # Create feature without geometry for no-GPS images but with all other data
                feature = {
                    "type": "Feature",
                    "id": feature_id,
                    "properties": {
                        "id": feature_id,
                        "longitude": None,
                        "latitude": None,
                        "imageUrl_high": image_url_high,
                        "imageUrl_Comp": image_url_comp,
                        "initialYaw": 0.0,
                        "initialPitch": pitch,
                        "initialHfov": hfov,
                        "showCompass": False,  # No compass without GPS
                        "capture_date": img_data['time'].strftime('%Y-%m-%d %H:%M:%S'),
                        "has_gps": False  # Flag to indicate no GPS
                    }
                }
            else:
                # Create feature with geometry for GPS images
                feature = {
                    "type": "Feature",
                    "id": feature_id,
                    "geometry": {
                        "type": "Point",
                        "coordinates": [lon, lat]
                    },
                    "properties": {
                        "id": feature_id,
                        "longitude": lon,
                        "latitude": lat,
                        "imageUrl_high": image_url_high,
                        "imageUrl_Comp": image_url_comp,
                        "initialYaw": 0.0,  # Will be calculated later
                        "initialPitch": pitch,
                        "initialHfov": hfov,
                        "showCompass": True,
                        "capture_date": img_data['time'].strftime('%Y-%m-%d %H:%M:%S'),
                        "has_gps": True  # Flag to indicate GPS available
                    }
                }

            features.append(feature)

        geojson = {
            "type": "FeatureCollection",
            "features": features
        }

        # Write to file
        with open(output_file, 'w') as f:
            json.dump(geojson, f, indent=2)

        logger.info(f"Created GeoJSON: {output_file} with {len(features)} features ({no_gps_count} without GPS)")
        return output_file

    def calculate_hfov(self, focal_length: Optional[float]) -> int:
        """Calculate horizontal field of view from focal length"""
        try:
            if focal_length and focal_length > 0:
                # Simplified calculation for 35mm equivalent
                sensor_width = 36  # mm for full frame
                hfov = int(2 * math.atan(sensor_width / (2 * focal_length)) * 180 / math.pi)
                # Clamp to reasonable range
                return max(50, min(120, hfov))
            return 100  # Default value
        except Exception as e:
            logger.debug(f"HFOV calculation error: {e}, using default")
            return 100  # Default value on error


# ============================================================================
# MODULE 7: Image Compression
# ============================================================================

class ImageCompressor:
    """Compresses images to target size"""

    def compress_image(self, image_path: str, output_path: str, max_size_kb: int = 100):
        """Compress image to target size"""
        try:
            from PIL import Image

            img = Image.open(image_path)

            # Start with quality 95
            quality = 95
            while quality > 10:
                img.save(output_path, 'JPEG', quality=quality, optimize=True)

                # Check file size
                file_size_kb = os.path.getsize(output_path) / 1024

                if file_size_kb <= max_size_kb:
                    logger.debug(f"Compressed to {file_size_kb:.1f}KB at quality {quality}")
                    return True

                quality -= 5

            logger.warning(f"Could not compress {image_path} to target size")
            return False

        except Exception as e:
            logger.error(f"Error compressing image: {e}")
            return False


# ============================================================================
# MODULE 8: Database Operations
# ============================================================================

class DatabaseManager:
    """Handles database operations"""

    def __init__(self):
        self.conn = None
        self.connect()

    def connect(self):
        """Establish database connection"""
        try:
            import psycopg2
            self.conn = psycopg2.connect(
                database=Config.DB_NAME,
                user=Config.DB_USER,
                password=Config.DB_PASSWORD,
                host=Config.DB_HOST,
                port=Config.DB_PORT,
                connect_timeout=10,
                # TCP keepalives: the server/firewall drops connections idle >~10 min
                keepalives=1,
                keepalives_idle=30,
                keepalives_interval=10,
                keepalives_count=5,
            )
            logger.info("Database connection established")
        except Exception as e:
            logger.error(f"Database connection failed: {e}")
            self.conn = None

    def ensure_connection(self) -> bool:
        """Probe the connection and reconnect if the server dropped it.

        The EXIF/snap-to-road phase can run 10-15+ minutes with no DB
        activity, after which the idle connection is dead ("server closed
        the connection unexpectedly"). Probe and reconnect before any use.
        """
        if self.conn is not None and not self.conn.closed:
            try:
                cur = self.conn.cursor()
                cur.execute("SELECT 1")
                cur.close()
                return True
            except Exception as e:
                logger.warning(f"Stale database connection detected: {e}")
                try:
                    self.conn.close()
                except Exception:
                    pass
                self.conn = None
        self.connect()
        return self.conn is not None

    def store_track_metadata(self, track_folder: str, images_count: int) -> bool:
        """
        Store track metadata in database - DISABLED as per user request
        No tracks table exists in database, so this is a no-op
        """
        # No-op - tracks table doesn't exist
        logger.debug(f"Track metadata storage skipped (no tracks table): {track_folder} with {images_count} images")
        return True

    def store_geojson_features(self, geojson_path: str, track_name: str, capture_dates: dict = None) -> bool:
        """
        Store GeoJSON features with image URLs to database - handles NULL GPS

        Args:
            geojson_path: Path to GeoJSON file
            track_name: Name of the track (e.g., 'track0')
            capture_dates: Dictionary mapping track numbers to capture dates

        Returns:
            bool: True if successful, False otherwise
        """
        if not self.ensure_connection():
            logger.error("No database connection after reconnect attempt")
            return False

        try:
            # Read GeoJSON file
            with open(geojson_path, 'r') as f:
                geojson_data = json.load(f)

            cursor = self.conn.cursor()

            # Get track number from track name
            track_num = track_name.replace('track', '')
            capture_date_value = capture_dates.get(track_num) if capture_dates else None

            # Insert each feature
            for feature in geojson_data['features']:
                props = feature['properties']

                # Check if feature has geometry (GPS data)
                has_geometry = 'geometry' in feature and feature['geometry'] is not None

                if has_geometry:
                    coords = feature['geometry']['coordinates']  # [longitude, latitude]
                    lon_original = coords[0]
                    lat_original = coords[1]
                    lon_snapped = props.get('longitude', lon_original)
                    lat_snapped = props.get('latitude', lat_original)

                    # Insert with PostGIS geometry for GPS images
                    cursor.execute("""
                        INSERT INTO image_features_4 (
                            feature_id, image_url_high, image_url_comp, initial_yaw, initial_pitch,
                            initial_hfov, show_compass, longitude_original, latitude_original,
                            longitude_snapped, latitude_snapped, capture_date, geom
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                        )
                    """, (
                        props['id'],
                        props['imageUrl_high'],
                        props['imageUrl_Comp'],
                        props['initialYaw'],
                        props['initialPitch'],
                        props['initialHfov'],
                        props['showCompass'],
                        lon_original,
                        lat_original,
                        lon_snapped,
                        lat_snapped,
                        capture_date_value,
                        lon_snapped,  # For PostGIS POINT (longitude first)
                        lat_snapped   # For PostGIS POINT (latitude second)
                    ))
                else:
                    # Insert without geometry for no-GPS images
                    cursor.execute("""
                        INSERT INTO image_features_4 (
                            feature_id, image_url_high, image_url_comp, initial_yaw, initial_pitch,
                            initial_hfov, show_compass, longitude_original, latitude_original,
                            longitude_snapped, latitude_snapped, capture_date, geom
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NULL
                        )
                    """, (
                        props['id'],
                        props['imageUrl_high'],
                        props['imageUrl_Comp'],
                        props['initialYaw'],
                        props['initialPitch'],
                        props['initialHfov'],
                        props['showCompass'],
                        None,  # longitude_original = NULL
                        None,  # latitude_original = NULL
                        None,  # longitude_snapped = NULL
                        None,  # latitude_snapped = NULL
                        capture_date_value
                    ))

            self.conn.commit()

            # Count GPS vs no-GPS images
            gps_count = sum(1 for f in geojson_data['features'] if f.get('properties', {}).get('has_gps', False))
            no_gps_count = len(geojson_data['features']) - gps_count

            logger.info(f"Successfully stored {len(geojson_data['features'])} features for {track_name} ({gps_count} with GPS, {no_gps_count} without GPS)")
            return True

        except Exception as e:
            logger.error(f"Error inserting features: {str(e)}")
            self.conn.rollback()
            return False

    def update_capture_dates(self, capture_dates: dict) -> int:
        """
        Update capture dates for tracks in database

        Args:
            capture_dates: Dictionary mapping track numbers to capture dates

        Returns:
            int: Number of records updated
        """
        if not self.conn or not capture_dates:
            return 0

        try:
            cursor = self.conn.cursor()
            updated_count = 0

            for track_num, capture_date in capture_dates.items():
                if capture_date:
                    cursor.execute("""
                        UPDATE image_features_4
                        SET capture_date = %s
                        WHERE feature_id LIKE %s
                    """, (capture_date, f'{track_num}_%'))

                    updated_count += cursor.rowcount
                    logger.info(f"Updated {cursor.rowcount} records for track {track_num}")

            self.conn.commit()
            return updated_count

        except Exception as e:
            logger.error(f"Error updating capture dates: {str(e)}")
            self.conn.rollback()
            return 0

    def get_track_statistics(self, track_name: str) -> dict:
        """Get statistics for a specific track"""
        if not self.conn:
            return {}

        try:
            cursor = self.conn.cursor()

            # Extract track number from track name (e.g., "track3499" -> 3499)
            track_number = track_name.replace('track', '')

            cursor.execute("""
                SELECT
                    COUNT(*) as total_features,
                    COUNT(DISTINCT capture_date) as unique_dates,
                    MIN(capture_date) as first_capture,
                    MAX(capture_date) as last_capture
                FROM image_features_4
                WHERE feature_id LIKE %s
            """, (f'{track_number}_%',))

            result = cursor.fetchone()

            return {
                'total_features': result[0],
                'unique_dates': result[1],
                'first_capture': result[2],
                'last_capture': result[3]
            }

        except Exception as e:
            logger.error(f"Error getting track statistics: {str(e)}")
            return {}

    def close(self):
        """Close database connection"""
        if self.conn:
            self.conn.close()
            logger.info("Database connection closed")


# ============================================================================
# MODULE 9: Progress Tracking & Reporting
# ============================================================================

class ProgressTracker:
    """Tracks and reports progress"""

    def __init__(self, total_steps: int = 12):
        self.total_steps = total_steps
        self.current_step = 0
        self.step_names = [
            "Initialization",
            "ZIP Validation",
            "ZIP Extraction",
            "EXIF Extraction",
            "GPS Processing",
            "Image Grouping",
            "Track Creation",
            "GeoJSON Generation",
            "Track Metadata Storage",
            "Image URLs Database Insert",
            "Statistics Update",
            "Cleanup"
        ]

    def update_progress(self, step: int, message: str = ""):
        """Update progress"""
        self.current_step = step
        progress_percent = int((step / self.total_steps) * 100)

        progress_bar = "█" * (progress_percent // 5) + "░" * (20 - progress_percent // 5)
        step_name = self.step_names[step] if step < len(self.step_names) else ""

        print(f"\r[{progress_bar}] {progress_percent}% - {step_name}: {message}", end='', flush=True)

        if message:
            logger.info(f"Step {step}/{self.total_steps}: {step_name} - {message}")

    def complete(self):
        """Mark progress as complete"""
        print(f"\r[{'█' * 20}] 100% - Complete! {' ' * 30}")
        logger.info("Processing completed successfully")


# ============================================================================
# MAIN PROCESSOR CLASS
# ============================================================================

class ZIPUploadProcessor:
    """Main processor for ZIP uploads"""

    def __init__(self, min_distance: float = 2.0):
        self.min_distance = min_distance
        self.file_manager = FileManager()
        self.exif_extractor = EXIFExtractor()
        self.gps_processor = GPSProcessor()
        self.image_grouper = ImageGrouper()
        self.track_manager = TrackManager(Config.BASE_DIR)
        self.geojson_generator = GeoJSONGenerator(image_grouper=self.image_grouper)
        self.image_compressor = ImageCompressor()
        self.db_manager = DatabaseManager()
        self.progress = ProgressTracker()

    def process_zip(self, zip_path: str) -> Dict[str, Any]:
        """Main processing pipeline"""
        logger.info(f"Starting ZIP processing: {zip_path}")
        start_time = datetime.now()

        result = {
            'success': False,
            'tracks_created': [],
            'total_images': 0,
            'gps_images': 0,
            'no_gps_images': 0,
            'error': None,
            'processing_time': None
        }

        try:
            # Step 1: Validate ZIP
            self.progress.update_progress(1, "Validating ZIP file...")
            if not self.file_manager.validate_zip(zip_path):
                raise ValueError("Invalid ZIP file or no images found")

            # Step 2: Extract ZIP
            self.progress.update_progress(2, "Extracting images...")
            extracted_files = self.file_manager.extract_zip(zip_path)
            if not extracted_files:
                raise ValueError("No images extracted from ZIP")

            # Step 3: Extract EXIF data
            self.progress.update_progress(3, f"Extracting EXIF from {len(extracted_files)} images...")
            images_metadata = []
            gps_count = 0
            no_gps_count = 0

            for idx, file_path in enumerate(extracted_files):
                if idx % 10 == 0:
                    self.progress.update_progress(3, f"Processing image {idx+1}/{len(extracted_files)}...")

                metadata = self.exif_extractor.extract_image_metadata(file_path)
                if metadata:
                    # Process GPS (handles NULL gracefully)
                    processed_data = self.gps_processor.process_coordinates(metadata)
                    images_metadata.append(processed_data)

                    # Count GPS vs no-GPS
                    if processed_data.get('has_gps'):
                        gps_count += 1
                    else:
                        no_gps_count += 1

            logger.info(f"EXIF extraction complete: {gps_count} with GPS, {no_gps_count} without GPS")

            if not images_metadata:
                raise ValueError("No valid images found in ZIP")

            # Step 4: Group images by time gaps
            self.progress.update_progress(4, f"Grouping {len(images_metadata)} images into tracks...")
            image_groups = self.image_grouper.group_images_by_time_gap(images_metadata)

            # Step 5: Create tracks
            # The connection has been idle through the whole EXIF phase; the
            # server already dropped it in past runs, which silently fell back
            # to track 0. Reconnect first, and refuse to guess if DB is down.
            if not self.db_manager.ensure_connection():
                raise ValueError("Database unavailable: cannot determine next track number safely")
            starting_track_num = self.image_grouper.get_next_track_number(Config.BASE_DIR, self.db_manager)
            self.progress.update_progress(5, f"Creating {len(image_groups)} track folders starting from track{starting_track_num}...")

            for group_idx, image_group in enumerate(image_groups):
                try:
                    track_num = starting_track_num + group_idx
                    track_folder = self.track_manager.create_track_folder(track_num)
                    track_name = os.path.basename(track_folder)

                    # Copy images to track folder with correct naming
                    for img_idx, img_data in enumerate(image_group, 1):
                        self.track_manager.copy_image_to_track(img_data, track_folder, img_idx, track_num)

                    # Generate GeoJSON with track number for feature IDs
                    self.progress.update_progress(6, f"Creating GeoJSON for track {track_num}...")
                    geojson_path = self.geojson_generator.create_geojson(track_folder, image_group, track_num)

                    # Track metadata storage is DISABLED (no tracks table)
                    # self.db_manager.store_track_metadata(track_folder, len(image_group))

                    # Store GeoJSON features with image URLs to database
                    self.progress.update_progress(7, f"Storing {len(image_group)} image URLs to database...")

                    # Get capture date from first image in group
                    capture_date_str = None
                    if image_group and len(image_group) > 0:
                        first_image_time = image_group[0].get('time')
                        if first_image_time:
                            capture_date_str = first_image_time.strftime('%Y-%m-%d %H:%M:%S')

                    capture_dates = {str(track_num): capture_date_str}
                    success = self.db_manager.store_geojson_features(geojson_path, track_name, capture_dates)

                    if success:
                        logger.info(f"✅ Stored {len(image_group)} image URLs for track {track_num}")

                        # Get statistics
                        stats = self.db_manager.get_track_statistics(track_name)
                        if stats:
                            logger.info(f"   Track stats: {stats}")
                    else:
                        logger.warning(f"⚠️ Failed to store image URLs for track {track_num}")

                    result['tracks_created'].append(track_folder)

                except Exception as e:
                    logger.error(f"Error processing track group {group_idx}: {e}")
                    logger.error(traceback.format_exc())
                    # Continue with next track group
                    continue

            result['total_images'] = len(images_metadata)
            result['gps_images'] = gps_count
            result['no_gps_images'] = no_gps_count
            result['success'] = True

            # Final step: Cleanup
            self.progress.update_progress(9, "Cleaning up temporary files...")
            self.file_manager.cleanup_temp_files()

            # Calculate processing time
            end_time = datetime.now()
            result['processing_time'] = (end_time - start_time).total_seconds()

            self.progress.complete()
            logger.info(f"Processing completed in {result['processing_time']:.2f} seconds")

        except Exception as e:
            result['error'] = str(e)
            logger.error(f"Processing failed: {e}")
            logger.error(traceback.format_exc())
            print(f"\n❌ Error: {e}")
            print("\nFor detailed error information, check: upload_processor.log")
            print("You can run with debug mode: python standalone_upload_processor.py --debug your_file.zip")

        finally:
            try:
                self.file_manager.cleanup_temp_files()
            except Exception as cleanup_error:
                logger.error(f"Error during cleanup: {cleanup_error}")

            try:
                self.db_manager.close()
            except Exception as db_error:
                logger.error(f"Error closing database: {db_error}")

        return result


# ============================================================================
# MAIN ENTRY POINT
# ============================================================================

def main():
    """Main entry point"""
    # Check for required libraries
    try:
        import psycopg2
        import requests
        from PIL import Image
    except ImportError as e:
        print(f"\n❌ Missing required library: {e}")
        print("\nPlease install required libraries:")
        print("  pip install psycopg2-binary requests Pillow")
        print("\nOr install all requirements:")
        print("  pip install -r requirements.txt")
        sys.exit(1)

    parser = argparse.ArgumentParser(description='Process ZIP uploads standalone')
    parser.add_argument('zip_file', help='Path to ZIP file')
    parser.add_argument('min_distance', type=float, nargs='?', default=2.0,
                       help='Minimum distance between points (meters)')
    parser.add_argument('--debug', action='store_true',
                       help='Enable debug logging')

    args = parser.parse_args()

    # Enable debug logging if requested
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
        for handler in logging.getLogger().handlers:
            handler.setLevel(logging.DEBUG)
        logger.setLevel(logging.DEBUG)
        print("Debug mode enabled")

    if not os.path.exists(args.zip_file):
        print(f"❌ Error: ZIP file not found: {args.zip_file}")
        return

    print("=" * 60)
    print("STANDALONE ZIP UPLOAD PROCESSOR")
    print("=" * 60)
    print(f"ZIP File: {args.zip_file}")
    print(f"Min Distance: {args.min_distance} meters")
    print(f"Started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    try:
        processor = ZIPUploadProcessor(min_distance=args.min_distance)
        result = processor.process_zip(args.zip_file)

        print("\n" + "=" * 60)
        print("PROCESSING RESULTS")
        print("=" * 60)

        if result['success']:
            print(f"✅ Success! Processed {result['total_images']} images")
            print(f"📍 GPS Images: {result['gps_images']}")
            print(f"🚫 No-GPS Images: {result['no_gps_images']}")
            print(f"📁 Tracks created: {len(result['tracks_created'])}")
            for track in result['tracks_created']:
                print(f"   - {track}")
            print(f"⏱️  Processing time: {result['processing_time']:.2f} seconds")

            if result['no_gps_images'] > 0:
                print(f"\nℹ️  Note: {result['no_gps_images']} images without GPS were still processed")
                print(f"   They have NULL coordinates but all other data is preserved")

            print("\n🎉 All tracks processed successfully!")
        else:
            print(f"❌ Failed: {result['error']}")

        print("=" * 60)

    except Exception as e:
        print(f"\n❌ Fatal error: {e}")
        logger.error(traceback.format_exc())


if __name__ == "__main__":
    main()
    # processor = ImageGrouper()
    
    # result = processor.get_next_track_number(Config.BASE_DIR, db_manager=DatabaseManager())
    
    # print(f"Next available track number: {result}")