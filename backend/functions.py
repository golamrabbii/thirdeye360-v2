import streamlit as st
# import mapbox_vector_tile
# from geojson2vt import geojson2vt
import subprocess
import os
import glob
import time
from datetime import datetime
import json
import math
import psycopg2
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import zipfile
from io import BytesIO
import shutil
from PIL import Image
from PIL.ExifTags import TAGS
import logging
import requests
from datetime import datetime
from geopy.distance import geodesic
from streamlit_cookies_controller import CookieController
import psutil
from concurrent.futures import ThreadPoolExecutor, as_completed
import tempfile
import hashlib
from fastapi import Depends, FastAPI, HTTPException, Response
from threading import Lock
from config import Config

_track_mount_lock = Lock()
_mounted_tracks = set()


# Set global temp directory
CUSTOM_TEMP_ROOT = Config.TEMP_ROOT
BASE_DIR = Config.BASE_DIR
os.makedirs(CUSTOM_TEMP_ROOT, exist_ok=True)

tempfile.tempdir = CUSTOM_TEMP_ROOT
os.environ.update({
    'TMPDIR': CUSTOM_TEMP_ROOT,
    'TEMP': CUSTOM_TEMP_ROOT,
    'TMP': CUSTOM_TEMP_ROOT,
    'EXIFTOOL_TMP': CUSTOM_TEMP_ROOT
})

# Global variable to track merge state
_last_merge_state = {
    "last_merge_time": None,
    "track_folders": {},
    "merged_hash": None
}


# Setup logging (will be overridden by api.py but provides fallback)
logger = logging.getLogger(__name__)
cookie_controller = CookieController()


# Minimum distance between points in meters
MIN_DISTANCE_METERS = Config.MIN_DISTANCE_METERS
MAX_BATCH_SIZE = Config.MAX_BATCH_SIZE

def get_db_connection():
    """Establish connection to PostgreSQL database"""
    try:
        conn = psycopg2.connect(
            database=Config.DB_NAME,
            user=Config.DB_USER,
            password=Config.DB_PASSWORD,
            host=Config.DB_HOST,
            port=Config.DB_PORT,
            # libpq's default connect timeout is INFINITE — without this a
            # single stalled TCP connect at startup wedged the whole server
            # before it answered its first request.
            connect_timeout=5,
        )
        return conn
    except Exception as e:
        logger.error(f"Database connection failed: {str(e)}")
        return None

def get_mounted_tracks():
    """Get set of currently mounted track folders"""
    with _track_mount_lock:
        return _mounted_tracks.copy()


class CacheControlStaticFiles(StaticFiles):
    """StaticFiles with a Cache-Control header.

    Starlette's StaticFiles never sets Cache-Control, so every browser hit
    revalidates against the server even though track images are immutable.
    The ETag/Range handling from Starlette's FileResponse is kept.
    """

    def __init__(self, *args, cache_control="public, max-age=604800", **kwargs):
        super().__init__(*args, **kwargs)
        self._cache_control = cache_control

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = self._cache_control
        return response


def mount_single_track_folder(app: FastAPI, folder_path: str):
    """Mount a single track folder as a static route"""
    with _track_mount_lock:
        route_name = os.path.basename(folder_path)
        if route_name in _mounted_tracks:
            return False

        mount_path = f"/{route_name}"
        app.mount(
            mount_path,
            CacheControlStaticFiles(directory=folder_path),
            name=route_name,
        )
        _mounted_tracks.add(route_name)
        logger.info(f"Mounted track folder: {route_name}")
        return True

def mount_new_track_folders(app: FastAPI, base_dir: str = Config.BASE_DIR):
    """Mount only new track folders that haven't been mounted yet"""
    current_tracks = set(glob.glob(os.path.join(base_dir, "track*")))
    mounted_tracks = get_mounted_tracks()
    
    new_tracks = [
        f for f in current_tracks 
        if os.path.isdir(f) and os.path.basename(f) not in mounted_tracks
    ]
    
    if not new_tracks:
        return 0
    
    # Mount new tracks in parallel
    with ThreadPoolExecutor() as executor:
        futures = []
        for folder in new_tracks:
            futures.append(executor.submit(mount_single_track_folder, app, folder))
        
        # Wait for all mounts to complete
        mounted_count = sum(1 for f in futures if f.result())
    
    return mounted_count



def mount_all_track_folders(app: FastAPI, base_dir: str = Config.BASE_DIR):
    """Mounts all folders starting with 'track' as static file routes"""
    # First unmount any existing track folders to avoid duplicates
    for route in list(app.routes):
        if hasattr(route, 'name') and route.name and route.name.startswith('track'):
            app.routes.remove(route)
    
    # Now mount all current track folders
    track_folders = glob.glob(os.path.join(base_dir, "track*"))
    for folder_path in track_folders:
        if os.path.isdir(folder_path):
            route_name = os.path.basename(folder_path)
            mount_path = f"/{route_name}"
            app.mount(
                mount_path,
                CacheControlStaticFiles(directory=folder_path),
                name=route_name,
            )
            _mounted_tracks.add(route_name)
    logger.info(f"Mounted {len(track_folders)} track folders")


def split_images_by_time_gap(image_data, gap_minutes=1):
    """Split images into groups based on time gaps between captures"""
    if not image_data:
        return []
    
    # Sort images by capture time
    image_data.sort(key=lambda x: x['time'])
    
    groups = []
    current_group = [image_data[0]]
    
    for i in range(1, len(image_data)):
        time_diff = (image_data[i]['time'] - image_data[i-1]['time']).total_seconds()
        if time_diff > gap_minutes * 60:  # Gap longer than specified minutes
            groups.append(current_group)
            current_group = [image_data[i]]
        else:
            current_group.append(image_data[i])
    
    if current_group:
        groups.append(current_group)
    
    return groups


def _check_if_merge_needed(project_dir=Config.BASE_DIR):
    """Check if we need to re-merge by comparing folder states"""
    global _last_merge_state
    
    # Get current track folders
    current_folders = sorted(
        glob.glob(os.path.join(project_dir, "track*")),
        key=lambda x: int(os.path.basename(x).replace("track", ""))
    )
    
    # If no folders exist, no merge needed
    if not current_folders:
        return False
    
    # If we've never merged before, we need to merge
    if not _last_merge_state["last_merge_time"]:
        return True
    
    # Check for added/removed folders
    current_folder_names = {os.path.basename(f) for f in current_folders}
    last_folder_names = set(_last_merge_state["track_folders"].keys())
    
    if current_folder_names != last_folder_names:
        return True
    
    # Check for modified data.json files
    for folder in current_folders:
        folder_name = os.path.basename(folder)
        data_json_path = os.path.join(folder, "data.json")
        
        if not os.path.exists(data_json_path):
            continue
            
        # Get current file stats
        current_mtime = os.path.getmtime(data_json_path)
        current_size = os.path.getsize(data_json_path)
        
        # Compare with last known state
        last_state = _last_merge_state["track_folders"].get(folder_name, {})
        if (last_state.get("mtime") != current_mtime or 
            last_state.get("size") != current_size):
            return True
    
    return False


def merge_all_track_geojsons(project_dir=Config.BASE_DIR, output_file="./merged_data.json"):
    """Merge all track folder data.json files into one consolidated GeoJSON"""
    global _last_merge_state
    
    try:
        logger.info(f"Starting merge process in directory: {os.path.relpath(project_dir)}")
        
        # First get capture dates for all track folders with proper timestamp handling
        track_dates = {}
        track_folders = sorted(
            glob.glob(os.path.join(project_dir, "track*")),
            key=lambda x: int(os.path.basename(x).replace("track", ""))
        )
        
        for folder in track_folders:
            folder_name = os.path.basename(folder)
            image_files = [f for f in os.listdir(folder) 
                         if f.endswith('.jpg') and '_comp' not in f]
            
            if image_files:
                first_image = sorted(image_files)[0]
                image_path = os.path.join(folder, first_image)
                
                try:
                    result = subprocess.run(
                        ['exiftool', '-DateTimeOriginal', '-d', '%Y-%m-%dT%H:%M:%S', '-s3', image_path],
                        capture_output=True,
                        text=True,
                        check=True
                    )
                    capture_datetime = result.stdout.strip()
                    
                    if not capture_datetime:
                        result = subprocess.run(
                            ['exiftool', '-CreateDate', '-d', '%Y-%m-%dT%H:%M:%S', '-s3', image_path],
                            capture_output=True,
                            text=True,
                            check=True
                        )
                        capture_datetime = result.stdout.strip()
                    
                    if capture_datetime:
                        try:
                            dt = datetime.strptime(capture_datetime, '%Y-%m-%dT%H:%M:%S')
                            display_date = dt.strftime('%B %d, %Y')
                            track_num = folder_name.replace("track", "")
                            track_dates[track_num] = {
                                'raw': dt.isoformat(),
                                'display': display_date,
                                'timestamp': dt.timestamp()
                            }
                        except ValueError:
                            track_num = folder_name.replace("track", "")
                            track_dates[track_num] = {
                                'raw': None,
                                'display': "Unknown",
                                'timestamp': None
                            }
                    else:
                        track_num = folder_name.replace("track", "")
                        track_dates[track_num] = {
                            'raw': None,
                            'display': "Unknown",
                            'timestamp': None
                        }
                        
                except Exception as e:
                    logger.warning(f"Could not get capture date for {image_path}: {str(e)}")
                    track_num = folder_name.replace("track", "")
                    track_dates[track_num] = {
                        'raw': None,
                        'display': "Unknown",
                        'timestamp': None
                    }
        
        # Merge features from all track folders
        merged_features = []
        current_folder_states = {}
        
        for track_folder in track_folders:
            folder_name = os.path.basename(track_folder)
            data_json_path = os.path.join(track_folder, "data.json")
            
            logger.info(f"Processing folder: {folder_name}")
            
            if not os.path.exists(data_json_path):
                logger.warning(f"No data.json found in {track_folder}")
                continue
                
            current_folder_states[folder_name] = {
                "mtime": os.path.getmtime(data_json_path),
                "size": os.path.getsize(data_json_path)
            }
            
            try:
                with open(data_json_path) as f:
                    data = json.load(f)
                    logger.info(f"Loaded data.json from {folder_name}")
                    
                    if 'features' not in data:
                        logger.warning(f"No features found in {folder_name}/data.json")
                        continue
                        
                    # Sort features by track and image number
                    track_features = sorted(
                        data['features'],
                        key=lambda x: (
                            int(x['properties']['id'].split('_')[0]),  # track number
                            int(x['properties']['id'].split('_')[1])    # image number
                        ))
                    
                    logger.info(f"Found {len(track_features)} features in {folder_name}")
                    
                    # Process each feature
                    for feature in track_features:
                        if 'geometry' in feature and 'coordinates' in feature['geometry']:
                            coords = feature['geometry']['coordinates']
                            if len(coords) >= 4:
                                # Keep original coords in properties
                                feature['geometry']['coordinates'] = coords[:2]
                                feature['properties']['longitude_snapped'] = coords[2]
                                feature['properties']['latitude_snapped'] = coords[3]
                                parts = feature['properties']['id'].split('_')
                                if len(parts) == 2:
                                    feature['properties']['id'] = f"{parts[0]}_{parts[1]}"
                                    # Add capture date information from track_dates
                                    track_num = parts[0]
                                    date_info = track_dates.get(track_num, {
                                        'raw': None,
                                        'display': "Unknown",
                                        'timestamp': None
                                    })
                                    feature['properties']['capture_date'] = date_info['display']
                                    feature['properties']['capture_date_raw'] = date_info['raw']
                                    feature['properties']['capture_date_timestamp'] = date_info['timestamp']
                            else:
                                logger.warning(f"Feature {feature['properties']['id']} has insufficient coordinates")
                        else:
                            logger.warning(f"Feature {feature.get('properties', {}).get('id', 'unknown')} missing geometry")
                            
                        merged_features.append(feature)
                        
            except Exception as e:
                logger.error(f"Error reading {data_json_path}: {str(e)}", exc_info=True)
                continue
        
        if not merged_features:
            logger.error("No features found to merge after processing all folders")
            return False
            
        # Sort all features
        merged_features.sort(
            key=lambda x: (
                int(x['properties']['id'].split('_')[0]),  # track number
                int(x['properties']['id'].split('_')[1])    # image number
            )
        )
        
        # Create final merged GeoJSON
        merged_geojson = {
            "type": "FeatureCollection",
            "features": merged_features
        }
        
        # Save merged GeoJSON
        output_path = os.path.relpath(output_file)
        logger.info(f"Saving merged data to {output_path}")
        
        with open(output_file, 'w') as f:
            json.dump(merged_geojson, f, indent=2)
        
        # Update merge state
        _last_merge_state = {
            "last_merge_time": datetime.now(),
            "track_folders": current_folder_states,
            "merged_hash": hashlib.md5(json.dumps(merged_geojson).encode()).hexdigest()
        }
        
        logger.info(f"Successfully merged {len(merged_features)} features from {len(track_folders)} track folders")
        return True
        
    except Exception as e:
        logger.error(f"Error merging GeoJSONs: {str(e)}", exc_info=True)
        return False
    
def process_single_image(args):
    """Thread worker function with proper temp file handling"""
    img, track_folder, track_num, idx = args
    try:
        ext = os.path.splitext(img['filename'])[1].lower()
        new_name = f"{track_num}_{idx}{ext}"
        dst_high = os.path.join(track_folder, new_name)
        
        # Ensure we're using proper temp files
        temp_dir = Config.TEMP_ROOT
        os.makedirs(temp_dir, exist_ok=True)
        os.environ['TMPDIR'] = temp_dir
        
        # Deface the image before moving to track folder
        # try:
        #     subprocess.run(
        #         ["deface", img['path'], "--thresh", "0.2", "-o", img['path']],
        #         check=True
        #     )
        # except Exception as e:
        #     logger.warning(f"Defacing failed for {img['filename']}: {str(e)}")
        
        # Move original image
        shutil.move(img['path'], dst_high)
        
        # Create compressed version
        dst_low = os.path.join(track_folder, f"{track_num}_{idx}_comp.jpg")
        compress_image_to_target_size(dst_high, dst_low)
        
        return True
    except Exception as e:
        logger.error(f"Error moving {img['filename']}: {str(e)}")
        return False    


def create_track_folders_for_groups(project_dir, image_groups):
    """Create separate track folders for each group of images using proper numbering with threading"""
    track_folders = []
    
    def process_group(group):
        try:
            # Get next available track folder
            track_folder = get_next_track_folder(project_dir)
            os.makedirs(track_folder, exist_ok=True)
            track_num = os.path.basename(track_folder).replace("track", "")
            
            # Process images in parallel
            with ThreadPoolExecutor() as executor:
                args_list = [(img, track_folder, track_num, idx+1) 
                            for idx, img in enumerate(group)]
                results = list(executor.map(process_single_image, args_list))
                
            # Create GeoJSON for this track
            geojson_path = os.path.join(track_folder, "data.json")
            if not create_geojson(image_folder=track_folder, output_file=geojson_path):
                logger.error(f"Failed to create GeoJSON for {track_folder}")
            
            return track_folder
        except Exception as e:
            logger.error(f"Error creating track folder: {str(e)}")
            return None
    
    # Process groups in parallel
    with ThreadPoolExecutor() as executor:
        futures = [executor.submit(process_group, group) for group in image_groups]
        for future in futures:
            result = future.result()
            if result:
                track_folders.append(result)
    
    return track_folders

            

def store_geojson_in_db(json_file_path):
    """Store GeoJSON features in PostgreSQL database with actual EXIF datetime"""
    conn = None
    try:
        logger.info(f"Storing GeoJSON from {json_file_path} in database")
        
        if not os.path.exists(json_file_path):
            logger.error(f"GeoJSON file not found at {json_file_path}")
            return False

        with open(json_file_path) as f:
            geojson_data = json.load(f)
        
        if 'features' not in geojson_data:
            logger.error("Invalid GeoJSON format - missing features")
            return False

        conn = get_db_connection()
        if not conn:
            logger.error("Database connection failed")
            return False
        
        cursor = conn.cursor()

        # Get capture dates mapping with actual EXIF datetime
        capture_dates = {}
        
        for feature in geojson_data['features']:
            props = feature['properties']
            feature_id = props['id']
            track_num, image_num = feature_id.split('_')
            
            if track_num not in capture_dates:
                # Get datetime for this track from the actual image
                track_folder = os.path.join(Config.BASE_DIR, f"track{track_num}")
                image_files = [f for f in os.listdir(track_folder) 
                             if f.endswith('.jpg') and '_comp' not in f and f.startswith(f"{track_num}_{image_num}")]
                
                if image_files:
                    image_path = os.path.join(track_folder, image_files[0])
                    
                    try:
                        # Get actual datetime from the specific image
                        result = subprocess.run(
                            ['exiftool', '-DateTimeOriginal', '-d', '%Y-%m-%dT%H:%M:%S', '-s3', image_path],
                            capture_output=True,
                            text=True,
                            check=True
                        )
                        capture_datetime = result.stdout.strip()
                        
                        if not capture_datetime:
                            # Fallback to CreateDate
                            result = subprocess.run(
                                ['exiftool', '-CreateDate', '-d', '%Y-%m-%dT%H:%M:%S', '-s3', image_path],
                                capture_output=True,
                                text=True,
                                check=True
                            )
                            capture_datetime = result.stdout.strip()
                        
                        if capture_datetime:
                            try:
                                dt = datetime.fromisoformat(capture_datetime)
                                capture_dates[track_num] = dt.isoformat()
                                logger.info(f"Found datetime for image {image_files[0]}: {capture_datetime}")
                            except ValueError:
                                capture_dates[track_num] = None
                        else:
                            capture_dates[track_num] = None
                            
                    except Exception as e:
                        logger.warning(f"Could not get datetime for {image_path}: {str(e)}")
                        capture_dates[track_num] = None
                else:
                    capture_dates[track_num] = None

        # Insert features with transaction handling
        try:
            for feature in geojson_data['features']:
                props = feature['properties']
                coords = feature['geometry']['coordinates']
                
                # Get capture date for this feature
                feature_id = props['id']
                track_num = feature_id.split('_')[0]
                
                # Use the actual datetime or NULL if not available
                capture_date_value = capture_dates.get(track_num)
                
                # Create PostGIS POINT from snapped coordinates
                # coords[2] = longitude_snapped, coords[3] = latitude_snapped
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
                    props['imageUrl_High'],
                    props['imageUrl_Comp'],
                    props['initialYaw'],
                    props['initialPitch'],
                    props['initialHfov'],
                    props['showCompass'],
                    coords[0],
                    coords[1],
                    coords[2],
                    coords[3],
                    capture_date_value,
                    coords[2],  # longitude_snapped for POINT
                    coords[3]   # latitude_snapped for POINT
                ))
            
            conn.commit()
            logger.info(f"Successfully stored {len(geojson_data['features'])} features with actual datetimes")
            return True
            
        except Exception as e:
            conn.rollback()
            logger.error(f"Error inserting features: {str(e)}")
            return False
            
    except Exception as e:
        logger.error(f"Unexpected error in store_geojson_in_db: {str(e)}")
        return False
    finally:
        if conn is not None:
            conn.close()


def snap_to_road(latitude, longitude, api_key=Config.BARIKOI_API_KEY):
    """Snap coordinates to nearest road using Barikoi API"""
    try:
        url = f"https://barikoi.xyz/v2/api/routing/nearest?point={latitude},{longitude}&api_key={api_key}"
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        if 'coordinates' in data and len(data['coordinates']) == 2:
            return {
                'longitude': data['coordinates'][0],
                'latitude': data['coordinates'][1],
                'distance': data.get('distance', 0)
            }
        return None
    except Exception as e:
        logger.error(f"Error snapping to road: {str(e)}")
        return None

def process_zip_logic(zip_path, upload_dir, temp_dir, project_dir):
    final_track_folder = store_unzip_images(
        zip_path, 
        project_dir=project_dir,
        project_temp_dir=temp_dir
    )

    if not final_track_folder:
        raise RuntimeError("Failed to process ZIP file")

    geojson_path = f"{final_track_folder}/data.json"
    if not create_geojson(image_folder=final_track_folder, output_file=geojson_path):
        raise RuntimeError("Failed to create GeoJSON")

    if not store_geojson_in_db(geojson_path):
        raise RuntimeError("Failed to store data in database")

    return {
        "track_folder": final_track_folder.split('/')[-1],
        "geojson_url": f"/{final_track_folder.split('/')[-1]}/data.json",
        "image_count": len([
            f for f in os.listdir(final_track_folder) 
            if f.endswith('.jpg') and '_comp' not in f
        ])
    }


def calculate_distance(lat1, lon1, lat2, lon2):
    """Calculate distance between two points in meters using geodesic distance"""
    return geodesic((lat1, lon1), (lat2, lon2)).meters

def dms_to_decimal(dms_str):
    parts = dms_str.split()
    degrees = float(parts[0])
    minutes = float(parts[2].replace("'", ""))
    seconds = float(parts[3].replace('"', ""))
    return degrees + (minutes/60) + (seconds/3600)

def calculate_yaw(lat1, lon1, lat2, lon2):
    """Calculate bearing between two GPS points"""
    d_lon = math.radians(lon2 - lon1)
    lat1, lat2 = math.radians(lat1), math.radians(lat2)
    y = math.sin(d_lon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(d_lon)
    bearing = math.degrees(math.atan2(y, x))
    return (bearing + 360) % 360  # Normalize to 0-360°

def calculate_smoothed_yaws(coordinates):
    """Calculate yaws with smoothing between points"""
    yaws = []
    for i in range(len(coordinates)):
        lat, lon, _ = coordinates[i]
        
        if i == 0 and len(coordinates) > 1:  # First point
            # Face toward next point
            next_lat, next_lon, _ = coordinates[i+1]
            yaw = calculate_yaw(lat, lon, next_lat, next_lon)
        elif i == len(coordinates) - 1:  # Last point
            # Face same direction as previous segment
            yaw = yaws[-1]
        else:  # Middle points
            # Average between previous and next directions
            prev_lat, prev_lon, _ = coordinates[i-1]
            next_lat, next_lon, _ = coordinates[i+1]
            
            yaw_to_prev = calculate_yaw(lat, lon, prev_lat, prev_lon)
            yaw_to_next = calculate_yaw(lat, lon, next_lat, next_lon)
            
            # Calculate average direction
            if abs(yaw_to_next - yaw_to_prev) > 180:
                # Handle wrap-around at 360°
                yaw = ((yaw_to_next + yaw_to_prev + 360) / 2) % 360
            else:
                yaw = (yaw_to_next + yaw_to_prev) / 2
            
        yaws.append(yaw)
    return yaws

def get_image_heading(image_path):
    """Extract compass heading from EXIF if available"""
    try:
        with Image.open(image_path) as img:
            exif = img._getexif()
            if exif:
                # Different cameras store heading in different tags
                for tag_id, value in exif.items():
                    tag = TAGS.get(tag_id, tag_id)
                    if tag in ['GPSImgDirection', 'PoseHeadingDegrees']:
                        return float(value)
    except Exception as e:
        logger.warning(f"Couldn't read heading from {image_path}: {e}")
    return None

def calculate_final_yaw(coordinates, img_path):
    """Calculate yaw using both path direction and EXIF data"""
    # Try to get heading from EXIF first
    exif_heading = get_image_heading(img_path)
    if exif_heading is not None:
        return exif_heading
    
    # Fall back to path-based calculation
    idx = [i for i, (_, _, path) in enumerate(coordinates) if path == img_path][0]
    smoothed_yaws = calculate_smoothed_yaws(coordinates)
    return smoothed_yaws[idx]

def extract_pitch_from_exif(metadata):
    for line in metadata:
        if 'Pose Pitch Degrees' in line:
            try:
                return float(line.split(':', 1)[1].strip())
            except ValueError:
                return None
    return None

def calculate_hfov_from_focal_length(metadata, sensor_width_mm=6.17):
    for line in metadata:
        if 'Focal Length' in line:
            try:
                focal_length_mm = float(line.split(':', 1)[1].strip().split(' ')[0])
                hfov_rad = 2 * math.atan(sensor_width_mm / (2 * focal_length_mm))
                return math.degrees(hfov_rad)
            except ValueError:
                return None
    return None

def filter_coordinates_by_distance(coordinates):
    """Filter coordinates to ensure minimum distance between points"""
    if not coordinates:
        return []
    
    filtered = [coordinates[0]]
    
    for i in range(1, len(coordinates)):
        last_lat, last_lon, _ = filtered[-1]
        current_lat, current_lon, _ = coordinates[i]
        
        distance = calculate_distance(last_lat, last_lon, current_lat, current_lon)
        
        if distance >= MIN_DISTANCE_METERS:
            filtered.append(coordinates[i])
        else:
            logger.info(f"Skipping point {i} - only {distance:.2f}m from previous point")
    
    return filtered




def create_geojson(image_folder, output_file="data.json", default_pitch=0, default_hfov=100):
    try:
        features = []
        image_files = sorted(
            [f for f in glob.glob(os.path.join(image_folder, '*.jpg')) if '_comp' not in f],
            key=lambda x: int(os.path.splitext(os.path.basename(x))[0].split('_')[-1])
        )

        track_name = os.path.basename(image_folder)
        base_url = f"{Config.API_BASE_URL}/{track_name}"
        api_key = Config.BARIKOI_API_KEY

        pitch_map = {}
        hfov_map = {}

        image_gps_data = []

        def extract_gps_and_metadata(img_path):
            try:
                # Set up environment for subprocess
                env = os.environ.copy()
                env['TMPDIR'] = "./third-eye-360/tmp"
                
                result = subprocess.run(
                    ['exiftool', '-GPSLatitude', '-GPSLongitude', '-GPSLatitudeRef', '-GPSLongitudeRef',
                     '-PosePitchDegrees', '-FocalLength', img_path],
                    capture_output=True,
                    text=True,
                    env=env,
                    check=True
                )

                metadata = result.stdout.split('\n')
                lat = lon = None
                lat_ref = lon_ref = ''
                for line in metadata:
                    if 'GPS Latitude' in line and 'Ref' not in line:
                        lat = dms_to_decimal(line.split(':', 1)[1].strip())
                    elif 'GPS Longitude' in line and 'Ref' not in line:
                        lon = dms_to_decimal(line.split(':', 1)[1].strip())
                    elif 'GPS Latitude Ref' in line:
                        lat_ref = line.split(':', 1)[1].strip()
                    elif 'GPS Longitude Ref' in line:
                        lon_ref = line.split(':', 1)[1].strip()

                if lat and lon:
                    if lat_ref == 'S':
                        lat = -lat
                    if lon_ref == 'W':
                        lon = -lon

                    pitch = extract_pitch_from_exif(metadata)
                    hfov = calculate_hfov_from_focal_length(metadata)

                    pitch_map[img_path] = pitch if pitch is not None else default_pitch
                    hfov_map[img_path] = hfov if hfov is not None else default_hfov

                    return (img_path, lat, lon)
                return None
            except Exception as e:
                logger.warning(f"Error extracting GPS from {os.path.basename(img_path)}: {str(e)}")
                return None

        with ThreadPoolExecutor() as executor:
            futures = {executor.submit(extract_gps_and_metadata, path): path for path in image_files}
            for future in as_completed(futures):
                result = future.result()
                if result:
                    image_gps_data.append(result)

        if not image_gps_data:
            logger.error("No images with valid GPS data found")
            return False

        # Step 2: Snap all GPS points in batches of 1100 using threads
        snapped_results = {}

        def snap_worker(batch):
            local_result = {}
            for img_path, lat, lon in batch:
                snapped = snap_to_road(lat, lon, api_key)
                if snapped:
                    local_result[img_path] = (snapped['latitude'], snapped['longitude'], lat, lon)
                else:
                    local_result[img_path] = (lat, lon, lat, lon)  # fallback
            return local_result

        batches = [image_gps_data[i:i + MAX_BATCH_SIZE] for i in range(0, len(image_gps_data), MAX_BATCH_SIZE)]

        with ThreadPoolExecutor() as executor:
            futures = [executor.submit(snap_worker, batch) for batch in batches]
            for future in as_completed(futures):
                snapped_results.update(future.result())

        coordinates = []
        org_coordinates = []

        for img_path, (lat, lon, lat_org, lon_org) in snapped_results.items():
            coordinates.append((lat, lon, img_path))
            org_coordinates.append((lat_org, lon_org))

        filtered_coordinates = filter_coordinates_by_distance(coordinates)
        logger.info(f"Filtered {len(coordinates)} → {len(filtered_coordinates)} (min {MIN_DISTANCE_METERS}m)")

        # Delete images that didn't make it through filtering
        filtered_paths = {path for _, _, path in filtered_coordinates}
        for img_path in snapped_results.keys():
            if img_path not in filtered_paths:
                try:
                    os.remove(img_path)
                    comp_path = img_path.replace('.jpg', '_comp.jpg')
                    if os.path.exists(comp_path):
                        os.remove(comp_path)
                except Exception as e:
                    logger.warning(f"Couldn't delete filtered image {img_path}: {str(e)}")

        path_to_original = {
            path: (lat_org, lon_org) for (_, _, path), (lat_org, lon_org) in zip(coordinates, org_coordinates)
        }

        yaws = []
        for i in range(len(filtered_coordinates)):
            if i < len(filtered_coordinates) - 1:
                lat1, lon1, _ = filtered_coordinates[i]
                lat2, lon2, _ = filtered_coordinates[i + 1]
                yaws.append(calculate_yaw(lat1, lat2, lon1, lon2))
            else:
                yaws.append(yaws[-1] if yaws else 0)

        for i, (lat, lon, img_path) in enumerate(filtered_coordinates):
            img_name = os.path.basename(img_path)
            img_id = os.path.splitext(img_name)[0]
            comp_path = img_path.replace('.jpg', '_comp.jpg')
            comp_name = os.path.basename(comp_path)
            lat_org, lon_org = path_to_original[img_path]
            final_yaw = calculate_final_yaw(filtered_coordinates, img_path)

            features.append({
                "type": "Feature",
                "properties": {
                    "id": img_id,
                    "imageUrl_High": f"{base_url}/{img_name}",
                    "imageUrl_Comp": f"{base_url}/{comp_name}",
                    "initialYaw": final_yaw,
                    "initialPitch": pitch_map[img_path],
                    "initialHfov": hfov_map[img_path],
                    "showCompass": True
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [lon_org, lat_org, lon, lat]
                }
            })

        with open(output_file, 'w') as f:
            json.dump({
                "type": "FeatureCollection",
                "features": features
            }, f, indent=2)

        logger.info(f"Created GeoJSON with {len(features)} features (coordinates snapped to road)")
        return True

    except Exception as e:
        logger.error(f"Failed to create GeoJSON: {str(e)}")
        return False


def get_capture_time(image_path):
    try:
        with Image.open(image_path) as image:
            exif_data = image._getexif()
            if exif_data is not None:
                for tag_id, value in exif_data.items():
                    tag = TAGS.get(tag_id, tag_id)
                    if tag == 'DateTimeOriginal':
                        # Convert EXIF format to datetime object
                        return datetime.strptime(value, '%Y:%m:%d %H:%M:%S')
    except Exception as e:
        logger.warning(f"Error reading EXIF from {image_path}: {e}")
    return None

def get_next_track_number():
    """
    Get next available track number from database.
    This is the single source of truth for track numbering.
    """
    try:
        conn = get_db_connection()
        if not conn:
            logger.error("Database connection failed for track number fetch")
            raise Exception("Cannot determine track number without database connection")
        
        cursor = conn.cursor()
        
        # Get highest track number from feature_id column
        cursor.execute("""
            SELECT MAX(CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER))
            FROM image_features_4
        """)
        
        result = cursor.fetchone()
        max_track = result[0] if result and result[0] is not None else None
        
        cursor.close()
        conn.close()
        
        if max_track is None:
            # No tracks in database, start from 0
            logger.info("No existing tracks in database, starting with track0")
            return 0
        else:
            next_num = max_track + 1
            logger.info(f"Found max track {max_track} in database, using track{next_num}")
            return next_num
        
    except Exception as e:
        logger.error(f"Error getting track number from database: {str(e)}")
        raise Exception(f"Failed to determine next track number: {str(e)}")


def get_next_track_folder(project_dir, base="track"):
    """Find next available track folder name using database as source of truth"""
    try:
        next_num = get_next_track_number()
        return os.path.join(project_dir, f"{base}{next_num}")
    except Exception as e:
        logger.error(f"Error getting next track folder: {str(e)}")
        raise


def log_memory_usage():
    """Log current memory and swap usage"""
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    logger.info(f"Memory - Used: {mem.used/1024/1024:.2f}MB, Available: {mem.available/1024/1024:.2f}MB")
    logger.info(f"Swap - Used: {swap.used/1024/1024:.2f}MB, Free: {swap.free/1024/1024:.2f}MB")

def has_sufficient_memory(required_mb=1024):
    """Check if system has enough available memory"""
    mem = psutil.virtual_memory()
    return mem.available > required_mb * 1024 * 1024


# Modify the store_unzip_images function signature
def store_unzip_images(zip_file_path, project_dir=None, project_temp_dir=None, gap_minutes=1, cancelled_event=None):
    """Process uploaded ZIP file and extract images to track folders using proper temp directories"""
    try:
        if project_dir is None:
            project_dir = Config.BASE_DIR
        
        # Use dedicated temp directory within project

        if project_temp_dir is None:
            project_temp_dir = os.path.join(Config.BASE_DIR, "temp_extract")
        
        os.makedirs(project_temp_dir, exist_ok=True)
        
        # Save old environment and tempdir states
        old_tmpdir = os.environ.get('TMPDIR')
        old_exiftool_tmp = os.environ.get('EXIFTOOL_TMP')
        old_tempdir = tempfile.tempdir
        
        # Force all temp files to our custom location
        os.environ['TMPDIR'] = project_temp_dir
        os.environ['EXIFTOOL_TMP'] = project_temp_dir
        tempfile.tempdir = project_temp_dir
        
        logger.info(f"Using project directory: {project_dir}")
        logger.info(f"Using temp directory: {project_temp_dir}")

        if cancelled_event and cancelled_event.is_set():
            logger.info("Processing cancelled before starting")
            shutil.rmtree(project_temp_dir, ignore_errors=True)
            return None

        try:
            api_key = Config.BARIKOI_API_KEY
        except Exception as e:
            logger.error(f"Failed to read API key: {str(e)}")
            shutil.rmtree(project_temp_dir, ignore_errors=True)
            return None

        image_extensions = ('.png', '.jpg', '.jpeg', '.bmp', '.gif')
        all_images = []
        
        def process_zip_member(member):
            try:
                if cancelled_event and cancelled_event.is_set():
                    return None
                    
                extracted_path = zip_ref.extract(member, project_temp_dir)
                full_path = os.path.relpath(os.path.join(project_temp_dir, member))
                
                try:
                    # Ensure subprocess uses our temp dir
                    env = os.environ.copy()
                    env['TMPDIR'] = project_temp_dir
                    
                    result = subprocess.run(
                        ['exiftool', '-GPSLatitude', '-GPSLongitude', 
                         '-GPSLatitudeRef', '-GPSLongitudeRef',
                         '-DateTimeOriginal', full_path],
                        capture_output=True,
                        text=True,
                        env=env,
                        check=True
                    )
                    
                    metadata = result.stdout.split('\n')
                    lat = lon = None
                    lat_ref = lon_ref = ''
                    capture_time = None

                    for line in metadata:
                        if 'GPS Latitude' in line and 'Ref' not in line:
                            lat = dms_to_decimal(line.split(':', 1)[1].strip())
                        elif 'GPS Longitude' in line and 'Ref' not in line:
                            lon = dms_to_decimal(line.split(':', 1)[1].strip())
                        elif 'GPS Latitude Ref' in line:
                            lat_ref = line.split(':', 1)[1].strip()
                        elif 'GPS Longitude Ref' in line:
                            lon_ref = line.split(':', 1)[1].strip()
                        elif 'Date/Time Original' in line:
                            try:
                                capture_time = datetime.strptime(
                                    line.split(':', 1)[1].strip(), 
                                    '%Y:%m:%d %H:%M:%S'
                                )
                            except:
                                pass

                    if lat and lon and capture_time:
                        if lat_ref == 'S':
                            lat = -lat
                        if lon_ref == 'W':
                            lon = -lon

                        snapped = snap_to_road(lat, lon, api_key)
                        if snapped:
                            lat, lon = snapped['latitude'], snapped['longitude']
                        
                        return {
                            'path': full_path,
                            'filename': os.path.basename(member),
                            'lat': lat,
                            'lon': lon,
                            'time': capture_time
                        }
                except Exception as e:
                    logger.warning(f"Couldn't get GPS data for {member}: {str(e)}")
                    os.remove(full_path)
                    return None
                    
            except Exception as e:
                logger.error(f"Error processing {member}: {str(e)}")
                return None
        
        with zipfile.ZipFile(zip_file_path, 'r') as zip_ref:
            image_members = [m for m in zip_ref.namelist() 
                           if m.lower().endswith(image_extensions)]
            
            if not image_members:
                logger.error("No image files found in ZIP archive")
                shutil.rmtree(project_temp_dir, ignore_errors=True)
                return None

            with ThreadPoolExecutor() as executor:
                futures = []
                for member in image_members:
                    if cancelled_event and cancelled_event.is_set():
                        break
                    futures.append(executor.submit(process_zip_member, member))
                
                for future in as_completed(futures):
                    if cancelled_event and cancelled_event.is_set():
                        break
                    result = future.result()
                    if result:
                        all_images.append(result)

        if cancelled_event and cancelled_event.is_set():
            logger.info("Processing cancelled during image extraction")
            shutil.rmtree(project_temp_dir, ignore_errors=True)
            return None

        if not all_images:
            logger.error("No images with valid GPS data found")
            shutil.rmtree(project_temp_dir, ignore_errors=True)
            return None

        image_groups = split_images_by_time_gap(all_images, gap_minutes)
        logger.info(f"Split images into {len(image_groups)} groups based on time gaps")
        
        # Get starting track number once at the beginning
        starting_track_num = get_next_track_number()
        logger.info(f"Starting track numbering from track{starting_track_num}")
        
        track_folders = []
        for group_idx, group in enumerate(image_groups):
            if cancelled_event and cancelled_event.is_set():
                break
                
            try:
                # Use incremented track number for each group
                current_track_num = starting_track_num + group_idx
                track_folder = os.path.join(project_dir, f"track{current_track_num}")
                os.makedirs(track_folder, exist_ok=True)
                track_num = str(current_track_num)
                logger.info(f"Processing group {group_idx + 1}/{len(image_groups)} → track{current_track_num}")
                
                with ThreadPoolExecutor() as executor:
                    args_list = [(img, track_folder, track_num, idx+1) 
                                for idx, img in enumerate(group)]
                    results = list(executor.map(process_single_image, args_list))
                    
                geojson_path = os.path.join(track_folder, "data.json")
                if not create_geojson(image_folder=track_folder, output_file=geojson_path):
                    logger.error(f"Failed to create GeoJSON for {track_folder}")
                
                track_folders.append(track_folder)
            except Exception as e:
                logger.error(f"Error creating track folder: {str(e)}")
                continue

        if cancelled_event and cancelled_event.is_set():
            logger.info("Processing cancelled during track folder creation")
            shutil.rmtree(project_temp_dir, ignore_errors=True)
            for folder in track_folders:
                if os.path.exists(folder):
                    shutil.rmtree(folder, ignore_errors=True)
            return None

        shutil.rmtree(project_temp_dir, ignore_errors=True)
        logger.info(f"Stored images to {len(track_folders)} track folders")
        
        for folder in track_folders:
            if cancelled_event and cancelled_event.is_set():
                break
                
            json_path = os.path.join(folder, "data.json")
            if not os.path.exists(json_path):
                logger.error(f"data.json missing in {folder} - creating now")
                if not create_geojson(image_folder=folder, output_file=json_path):
                    logger.error(f"Failed to create data.json in {folder}")
        
        return track_folders

    except Exception as e:
        logger.error(f"Unexpected error in store_unzip_images: {str(e)}", exc_info=True)
        if 'project_temp_dir' in locals() and os.path.exists(project_temp_dir):
            shutil.rmtree(project_temp_dir, ignore_errors=True)
        return None
    finally:
        # Restore old temporary directory states
        if 'old_tmpdir' in locals():
            if old_tmpdir is not None:
                os.environ['TMPDIR'] = old_tmpdir
            elif 'TMPDIR' in os.environ:
                del os.environ['TMPDIR']
                
        if 'old_exiftool_tmp' in locals():
            if old_exiftool_tmp is not None:
                os.environ['EXIFTOOL_TMP'] = old_exiftool_tmp
            elif 'EXIFTOOL_TMP' in os.environ:
                del os.environ['EXIFTOOL_TMP']
                
        if 'old_tempdir' in locals():
            tempfile.tempdir = old_tempdir

        if cancelled_event and cancelled_event.is_set():
            if 'project_temp_dir' in locals() and os.path.exists(project_temp_dir):
                shutil.rmtree(project_temp_dir, ignore_errors=True)
            if 'track_folders' in locals() and track_folders:
                for folder in track_folders:
                    if os.path.exists(folder):
                        shutil.rmtree(folder, ignore_errors=True)
    

def deface_images_in_folder(project_dir):
    for root, dirs, files in os.walk(project_dir):
        if "track" in root:
            for file in sorted(files):
                if file.lower().endswith(".jpg"):
                    image_path = os.path.join(root, file)
                    print(f"Processing: {image_path}")
                    try:
                        subprocess.run(
                            ["deface", image_path, "--thresh", "0.2", "-o", image_path],
                            check=True
                        )
                    except subprocess.CalledProcessError as e:
                        print(f"Failed to process {image_path}: {e}")
                    except Exception as ex:
                        print(f"Unexpected error with {image_path}: {ex}")


def process_images_from_folder(source_folder, target_folder):
    """Process images directly from a source folder to target track folder, chunked with progress bar."""
    try:
        image_extensions = ('.png', '.jpg', '.jpeg', '.bmp', '.gif')
        new_images_with_time = []
        filelist = [f for f in os.listdir(source_folder) if f.lower().endswith(image_extensions)]
        progress = st.progress(0, text="Reading and sorting images...")
        # Collect and sort images by capture time
        total = len(filelist)
        for idx, f in enumerate(filelist, 1):
            full_path = os.path.join(source_folder, f)
            capture_time = get_capture_time(full_path)
            if capture_time:
                new_images_with_time.append((full_path, f, capture_time))
            else:
                logger.warning(f"Skipped (no capture time): {f}")
            progress.progress(idx / total, text=f"Scanned {idx}/{total} images")

        new_images_sorted = sorted(new_images_with_time, key=lambda x: x[2] if x[2] else datetime.min)

        # Copy and rename images to target folder, show progress
        progress = st.progress(0, text="Copying and compressing images...")
        for idx, (src_path, original_name, _) in enumerate(new_images_sorted, start=1):
            ext = os.path.splitext(original_name)[1].lower()
            track_num = target_folder.replace("track", "")
            new_name = f"{track_num}_{idx}{ext}"
            dst_high = os.path.join(target_folder, new_name)
            shutil.copy2(src_path, dst_high)
            dst_low = os.path.join(target_folder, f"img_{track_num}_{idx}_comp.jpg")
            compress_image_to_target_size(dst_high, dst_low)
            progress.progress(idx / len(new_images_sorted), text=f"Processed {idx}/{len(new_images_sorted)} images")

        logger.info(f"Processed {len(new_images_sorted)} images from {source_folder}")
        return True

    except Exception as e:
        logger.error(f"Error processing folder {source_folder}: {str(e)}")
        return False
    

def compress_image_to_target_size(image_path, output_path, max_size_kb=100):
    try:
        # Set temp dir for PIL
        tempfile.tempdir = Config.TEMP_ROOT    

        with Image.open(image_path) as img:
            exif_data = img.info.get('exif', b'')
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
            # Binary search for optimal quality
            low, high = 10, 95
            best_quality = low
            buffer = BytesIO()
            
            while low <= high:
                mid = (low + high) // 2
                buffer.seek(0)
                buffer.truncate(0)
                img.save(buffer, format="JPEG", quality=mid, exif=exif_data)
                size_kb = buffer.tell() / 1024
                
                if size_kb <= max_size_kb:
                    best_quality = mid
                    low = mid + 5
                else:
                    high = mid - 5
            
            buffer.seek(0)
            buffer.truncate(0)
            img.save(buffer, format="JPEG", quality=best_quality, exif=exif_data)
            
            with open(output_path, 'wb') as f:
                f.write(buffer.getvalue())
                
            return True
    except Exception as e:
        logger.error(f"Error compressing image {image_path}: {e}")
        return False

def process_uploaded_images(image_folder):
    try:
        success = create_geojson(
            image_folder=image_folder,
            output_file="data.json"
        )
        
        if not success:
            st.error("Failed to create GeoJSON")
            return False
        
        if os.path.exists("data.json"):
            with open("data.json", "rb") as f:
                st.download_button(
                    label="Download GeoJSON",
                    data=f,
                    file_name="data.json",
                    mime="application/json"
                )
        
        return True
    except Exception as e:
        st.error(f"Error processing images: {str(e)}")
        return False

# Add to functions.py

def create_mbtiles(geojson_data, output_path):
    """Convert GeoJSON to MBTiles using Tippecanoe with optimized options"""
    import subprocess
    import tempfile
    import os
    import json   ### MODIFIED: json was missing in your imports

    try:
        # Create output directory if it doesn't exist
        output_dir = os.path.dirname(output_path)
        os.makedirs(output_dir, exist_ok=True)

        ### MODIFIED: Strict backup handling
        bak_path = output_path + ".bak"
        if os.path.exists(bak_path):
            os.remove(bak_path)  # force delete old backup
            logger.info(f"Deleted old backup: {bak_path}")
        if os.path.exists(output_path):
            os.rename(output_path, bak_path)  # move current to .bak
            logger.info(f"Renamed existing MBTiles to backup: {bak_path}")

        # Save GeoJSON to temp file
        with tempfile.NamedTemporaryFile(mode='w', suffix='.geojson', delete=False) as temp_file:
            json.dump(geojson_data, temp_file)
            temp_geojson = temp_file.name

        # Build optimized tippecanoe command for large datasets
        cmd = [
            'tippecanoe',
            '-zg',  # Auto-detect optimal zoom levels
            '--drop-rate=0.5',  # Allow some dropping for performance
            '--extend-zooms-if-still-dropping',
            '--maximum-tile-bytes=10000000',
            '--no-tile-compression',  # Better performance
            '--detect-shared-borders',
            '-l', 'images',
            '-n', 'Image Locations',
            '-o', output_path,
            temp_geojson
        ]

        logger.info(f"Running tippecanoe command: {' '.join(cmd)}")

        # Execute tippecanoe with proper environment
        env = os.environ.copy()
        env['TMPDIR'] = Config.TEMP_ROOT  # Use your configured temp directory

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            timeout=7200,  # 2 hour timeout for large datasets
            env=env,
            cwd=output_dir  # Run in output directory to avoid path issues
        )

        logger.info("Tippecanoe completed successfully")
        logger.info(f"Output: {result.stdout}")
        if result.stderr:
            logger.info(f"Tippecanoe info: {result.stderr}")

        logger.info(f"Successfully created MBTiles at: {output_path}")
        return True

    except subprocess.CalledProcessError as e:
        logger.error(f"Tippecanoe failed with exit code {e.returncode}")
        logger.error(f"Error: {e.stderr}")
        logger.error(f"Output: {e.stdout}")

        # Try fallback command with simpler options
        logger.info("Trying fallback tippecanoe command...")
        return create_mbtiles_fallback(geojson_data, output_path)

    except subprocess.TimeoutExpired:
        logger.error("Tippecanoe timed out after 2 hours")
        return False

    except Exception as e:
        logger.error(f"Error creating MBTiles: {str(e)}", exc_info=True)
        return False

    finally:
        # Clean up temporary file
        if 'temp_geojson' in locals() and os.path.exists(temp_geojson):
            try:
                os.unlink(temp_geojson)
            except Exception as e:
                logger.warning(f"Could not remove temp file {temp_geojson}: {str(e)}")


def create_mbtiles_fallback(geojson_data, output_path):
    """Fallback function with simpler options for large datasets"""
    import subprocess
    import tempfile
    
    try:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.geojson', delete=False) as temp_file:
            json.dump(geojson_data, temp_file)
            temp_geojson = temp_file.name
        
        # Simplified command for large datasets
        cmd = [
            'tippecanoe',
            '-zg',  # Auto-detect zoom levels
            '--drop-densest-as-needed',
            '--extend-zooms-if-still-dropping',
            '-l', 'images',
            '-o', output_path,
            temp_geojson
        ]
        
        logger.info(f"Running fallback command: {' '.join(cmd)}")
        
        env = os.environ.copy()
        env['TMPDIR'] = Config.TEMP_ROOT
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            timeout=7200,
            env=env,
            cwd=os.path.dirname(output_path)
        )
        
        logger.info(f"Fallback tippecanoe completed successfully")
        return True
        
    except Exception as e:
        logger.error(f"Fallback also failed: {str(e)}")
        return False
    finally:
        if 'temp_geojson' in locals() and os.path.exists(temp_geojson):
            try:
                os.unlink(temp_geojson)
            except:
                pass


def extract_track_name(feature_id):
    """Extract track name from feature_id (e.g., '0_1' -> 'track0')"""
    if '_' in feature_id:
        track_num = feature_id.split('_')[0]
        return f"track{track_num}"
    return None

def calculate_track_distance(track_name):
    """Calculate total distance covered by a specific track"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        
        # Extract track number from track_name (e.g., "track0" -> "0")
        track_num = track_name.replace('track', '')
        
        # Get all points for the track in sequence order
        cursor.execute("""
            SELECT latitude_snapped, longitude_snapped
            FROM image_features_4
            WHERE feature_id LIKE %s ESCAPE '\\'
            ORDER BY CAST(SPLIT_PART(feature_id, '_', 2) AS INTEGER)
        """, (f"{track_num}\\_%",))
        
        points = cursor.fetchall()
        
        if len(points) < 2:
            return 0.0
            
        total_distance = 0.0
        for i in range(len(points) - 1):
            lat1, lon1 = points[i]
            lat2, lon2 = points[i+1]
            distance = geodesic((lat1, lon1), (lat2, lon2)).meters
            total_distance += distance
            
        return total_distance
        
    except Exception as e:
        logger.error(f"Error calculating distance for {track_name}: {str(e)}")
        return 0.0
    finally:
        if conn:
            conn.close()

def get_all_track_names():
    """Get list of all track names from feature_id patterns"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT DISTINCT SPLIT_PART(feature_id, '_', 1) as track_num 
            FROM image_features_4 
            WHERE feature_id LIKE '%_%'
            ORDER BY CAST(SPLIT_PART(feature_id, '_', 1) AS INTEGER)
        """)
        
        track_nums = [row[0] for row in cursor.fetchall()]
        return [f"track{num}" for num in track_nums]
        
    except Exception as e:
        logger.error(f"Error getting track names: {str(e)}")
        return []
    finally:
        if conn:
            conn.close()


# Add this function to functions.py
def get_feature_image_paths(feature_id: str, base_dir: str = BASE_DIR) -> dict:
    """
    Get the file paths for a specific feature's images
    Returns: {"high_res": "/path/to/image.jpg", "compressed": "/path/to/image_comp.jpg"}
    """
    try:
        # Extract track number and image number
        track_num, image_num = feature_id.split('_')
        track_folder = f"track{track_num}"
        
        # Look for the image files
        track_path = os.path.join(base_dir, track_folder)
        if not os.path.exists(track_path):
            return {}
        
        # Pattern to match the image files
        high_res_pattern = os.path.join(track_path, f"{track_num}_{image_num}.*")
        comp_pattern = os.path.join(track_path, f"{track_num}_{image_num}_comp.*")
        
        high_res_files = glob.glob(high_res_pattern)
        comp_files = glob.glob(comp_pattern)
        
        result = {}
        if high_res_files:
            result["high_res"] = high_res_files[0]
        if comp_files:
            result["compressed"] = comp_files[0]
        
        return result
        
    except Exception as e:
        logger.error(f"Error getting image paths for {feature_id}: {str(e)}")
        return {}
    

def update_capture_dates_in_db():
    """Update capture_date column in database using actual EXIF datetime"""
    conn = None
    try:
        conn = get_db_connection()
        if not conn:
            logger.error("Database connection failed")
            return False
        
        cursor = conn.cursor()
        
        # Get all unique track numbers from the database
        cursor.execute("""
            SELECT DISTINCT SPLIT_PART(feature_id, '_', 1) as track_num 
            FROM image_features_4 
            WHERE feature_id LIKE '%_%'
            ORDER BY SPLIT_PART(feature_id, '_', 1)
        """)
        
        track_nums = [row[0] for row in cursor.fetchall()]
        
        if not track_nums:
            logger.info("No track numbers found in database")
            return True
            
        # Get capture dates directly from images
        capture_dates = {}
        valid_dates = {}
        
        for track_num in track_nums:
            track_folder = os.path.join(Config.BASE_DIR, f"track{track_num}")
            if not os.path.exists(track_folder):
                logger.warning(f"Track folder not found: track{track_num}")
                continue
                
            image_files = [f for f in os.listdir(track_folder) 
                         if f.endswith('.jpg') and '_comp' not in f]
            
            if not image_files:
                logger.warning(f"No images found in track{track_num}")
                continue
                
            # Use the first image to get capture date
            first_image = sorted(image_files)[0]
            image_path = os.path.join(track_folder, first_image)
            
            try:
                # Use exiftool to get the actual datetime with proper format
                result = subprocess.run(
                    ['exiftool', '-DateTimeOriginal', '-d', '%Y-%m-%dT%H:%M:%S', '-s3', image_path],
                    capture_output=True,
                    text=True,
                    check=True
                )
                capture_datetime = result.stdout.strip()
                
                if not capture_datetime:
                    # Fallback to CreateDate with proper format
                    result = subprocess.run(
                        ['exiftool', '-CreateDate', '-d', '%Y-%m-%dT%H:%M:%S', '-s3', image_path],
                        capture_output=True,
                        text=True,
                        check=True
                    )
                    capture_datetime = result.stdout.strip()
                
                if capture_datetime:
                    # Parse the ISO format datetime
                    try:
                        dt = datetime.fromisoformat(capture_datetime)
                        capture_dates[track_num] = dt.isoformat()
                        valid_dates[track_num] = capture_datetime
                        logger.info(f"Found datetime for track {track_num}: {capture_datetime}")
                    except ValueError as e:
                        logger.warning(f"Error parsing datetime {capture_datetime} for track {track_num}: {str(e)}")
                        capture_dates[track_num] = None
                else:
                    logger.warning(f"No capture date found for track {track_num}")
                    capture_dates[track_num] = None
                    
            except Exception as e:
                logger.warning(f"Could not get capture datetime for {image_path}: {str(e)}")
                capture_dates[track_num] = None
        
        # Update database for each track
        updated_count = 0
        for track_num in track_nums:
            if track_num in capture_dates and capture_dates[track_num]:
                # Update ALL records for this track with the actual datetime
                cursor.execute("""
                    UPDATE image_features_4
                    SET capture_date = %s::TIMESTAMPTZ
                    WHERE feature_id LIKE %s ESCAPE '\\'
                """, (capture_dates[track_num], f"{track_num}\\_%"))
                
                updated_count += cursor.rowcount
                logger.info(f"Updated {cursor.rowcount} records for track {track_num} with datetime: {capture_dates[track_num]}")
            else:
                logger.info(f"No valid capture date found for track {track_num}, skipping update")
        
        conn.commit()
        logger.info(f"Updated {updated_count} total records with valid capture datetimes")
        return True
            
    except Exception as e:
        logger.error(f"Error updating capture dates: {str(e)}", exc_info=True)
        if conn:
            conn.rollback()
        return False
    finally:
        if conn:
            conn.close()



