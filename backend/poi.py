import streamlit as st
import requests
import os
import base64
import mimetypes
import json
import subprocess
import psycopg2
from config import Config
import logging

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# -----------------------------
# DB connection
# -----------------------------
def get_db_connection():
    try:
        conn = psycopg2.connect(
            database=Config.DB_NAME,
            user=Config.DB_USER,
            password=Config.DB_PASSWORD,
            host=Config.DB_HOST,
            port=Config.DB_PORT
        )
        return conn
    except Exception as e:
        logger.error(f"Database connection failed: {str(e)}")
        return None

# -----------------------------
# Fetch feature JSON from API
# -----------------------------
def fetch_feature_json(feature_id):
    url = f"http://202.72.236.166:8001/api/features/{feature_id}"
    try:
        response = requests.get(url)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        st.error(f"Failed to fetch feature JSON: {e}")
        return None

# -----------------------------
# Download image from URL
# -----------------------------
def download_image(url, save_path):
    try:
        resp = requests.get(url)
        resp.raise_for_status()
        with open(save_path, "wb") as f:
            f.write(resp.content)
        return save_path
    except Exception as e:
        st.error(f"Failed to download image: {e}")
        return None

# -----------------------------
# Encode image
# -----------------------------
def encode_image(image_path):
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

# -----------------------------
# POI extraction via OpenAI
# -----------------------------
def extract_poi_from_image(image_path):
    base64_image = encode_image(image_path)
    mime_type, _ = mimetypes.guess_type(image_path)
    if mime_type is None:
        mime_type = "image/jpeg"

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {os.getenv('OPENAI_API_KEY')}",
    }

    system_prompt = """
You are an expert POI (Point of Interest) detection assistant. Detect EVERY visible text that could be a business, shop, signboard, or service. Include:
- Partially visible text
- Foreign language text (e.g., Bengali)
- Small or faint signs
- Signs behind obstacles or at angles

For each POI, return JSON fields:
- 'text': exact text
- 'type': guessed shop/business type
- 'language': language(s) of the text
- 'location': approximate location in image (e.g., 'top-right, green signboard')
- 'confidence': 0–1 indicating confidence

Rules:
1. Include ALL text even partially readable
2. Be exhaustive
3. Confidence for partial/uncertain signs
4. Strictly valid JSON list

Example:
[
  {
    "text": "Tasty Village",
    "type": "Restaurant",
    "language": "English",
    "location": "center-left, above red awning",
    "confidence": 0.95
  },
  {
    "text": "গ্লোরি ইসলামী ব্যাংক",
    "type": "Bank",
    "language": "Bengali",
    "location": "top-right, green signboard",
    "confidence": 0.88
  }
]
"""

    user_message = [
        {"type": "text", "text": "Detect POIs and guess shop types from this image. Include all visible text, even small, faint, or partially occluded. Assign confidence to each detection."},
        {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{base64_image}"}}
    ]

    payload = {
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ],
        "max_tokens": 1500
    }

    response = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers=headers,
        json=payload,
    )

    try:
        content = response.json()["choices"][0]["message"]["content"]
        if content.startswith("```"):
            content = content.split("```")[1]
            content = content.lstrip("json\n").strip("` \n")
        pois = json.loads(content)
        return pois
    except Exception as e:
        st.error(f"Failed to parse POI JSON: {e}")
        st.write("Raw response:", response.json())
        return []

# -----------------------------
# Insert into DB
# -----------------------------
def insert_pois_to_db(pois, latitude, longitude, imageUrl_High, source_id):
    conn = get_db_connection()
    if not conn:
        st.error("Database connection failed!")
        return

    try:
        with conn.cursor() as cur:
            for poi in pois:
                # Prepare PostGIS POINT geometry
                cur.execute("""
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
                    poi.get("text"),
                    poi.get("location"),
                    poi.get("type"),
                    poi.get("language"),
                    poi.get("confidence"),
                    poi.get("target_latitude"),
                    poi.get("target_longitude"),
                    latitude,
                    longitude,
                    image_url,  # <-- store API URL directly
                    longitude,  # X = lon
                    latitude    # Y = lat
                ))

        conn.commit()
        st.success("POI data inserted successfully!")
    except Exception as e:
        st.error(f"Database insert failed: {str(e)}")
    finally:
        conn.close()


# -----------------------------
# Streamlit App
# -----------------------------
st.title("POI Extraction via Feature API")

feature_id = st.text_input("Enter Feature ID (e.g., 75_998)")

if feature_id:
    feature_json = fetch_feature_json(feature_id)
    if feature_json is not None:
        # Extract lat/lon from feature JSON
        lat = feature_json["properties"].get("latitude_snapped") or feature_json["properties"].get("latitude_original")
        lon = feature_json["properties"].get("longitude_snapped") or feature_json["properties"].get("longitude_original")

        # Download image from imageUrl_High
        image_url = feature_json["properties"]["imageUrl_High"]
        temp_path = f"{feature_id}.jpg"
        downloaded = download_image(image_url, temp_path)
        print(downloaded)

        if downloaded:
            st.image(downloaded, caption="Fetched Image", use_column_width=True)

            if st.button("Extract POIs"):
                pois = extract_poi_from_image(downloaded)
                if pois:
                    st.json(pois)
                    insert_pois_to_db(pois, lat, lon, downloaded, feature_id)
