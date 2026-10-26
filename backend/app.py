import streamlit as st
from auth import *
from functions import *
import os
import logging
from config import Config

logger = logging.getLogger(__name__)

API_BASE_URL = Config.API_BASE_URL

# Local upload directory
UPLOAD_DIR = "temp_uploads"

def styled_file_uploader(min_distance=None):
    """Streamlit native file uploader with HTML uploader design"""

    # Custom CSS to match HTML uploader exactly
    st.markdown("""
    <style>
        .upload-box {
            border: 2px dashed #ccc;
            padding: 20px;
            text-align: center;
            margin: 10px 0;
            border-radius: 5px;
            width: 100%;
            box-sizing: border-box;
        }
        .config-section {
            background-color: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            margin: 10px 0;
            text-align: left;
        }
        #file-info {
            margin: 10px 0;
            font-size: 14px;
            word-wrap: break-word;
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
        }
    </style>
    """, unsafe_allow_html=True)

    # Upload box container
    st.markdown('<div class="upload-box">', unsafe_allow_html=True)
    st.markdown('<h3 style="margin-bottom: 15px;">Upload ZIP File</h3>', unsafe_allow_html=True)

    # Configuration section
    st.markdown(f"""
    <div class="config-section">
        <strong>Processing Settings:</strong><br>
        Minimum Distance: {min_distance if min_distance else 'Default (2)'} meters
        <br><small>Points closer than this distance will be filtered out</small>
    </div>
    """, unsafe_allow_html=True)

    # Streamlit native file uploader
    uploaded_file = st.file_uploader(
        "Choose a ZIP file",
        type=["zip"],
        help="Select a ZIP archive to upload",
        key="zip_file_uploader"
    )

    if uploaded_file is not None:
        # Show file info when file is selected
        file_size_mb = uploaded_file.size / (1024*1024)
        st.markdown(f"""
        <div id="file-info">
            <strong>Selected file:</strong> {uploaded_file.name}<br>
            <strong>Size:</strong> {file_size_mb:.2f} MB
        </div>
        """, unsafe_allow_html=True)

        st.success("📁 File selected - Ready to upload")

        # Upload button
        upload_clicked = st.button("Upload Now", type="primary", key="upload_now")

        if upload_clicked:
            st.session_state.upload_clicked = True
            st.rerun()

    st.markdown('</div>', unsafe_allow_html=True)

    return uploaded_file

def main():
    st.title("ThirdEye360")

    st.header("Upload 360 Images")

    # Create tabs for different upload methods
    tab1 = st.tabs(["Upload ZIP"])[0]

    with tab1:
        st.subheader("Upload ZIP Archive")

        # Display warning about large files
        st.warning("For large ZIP files (over 1GB), please be patient during upload.")

        # Add configuration section
        st.subheader("Processing Configuration")

        col1, col2 = st.columns([2, 1])

        with col1:
            min_distance = st.number_input(
                "Minimum Distance Between Points (meters)",
                min_value=0.5,
                max_value=50.0,
                value=2.0,
                step=0.5,
                help="Points closer than this distance will be filtered out to reduce redundancy"
            )

        with col2:
            st.metric(
                "Current Setting",
                f"{min_distance}m",
                help="This will be used during image processing"
            )

        # Add info about the setting
        st.info(f"""
        **Minimum Distance Setting:** {min_distance} meters

        - **Lower values** (0.5-1m): More detailed tracks, more images kept
        - **Higher values** (5-10m): Less detailed tracks, fewer images, faster processing
        - **Recommended:** 2-3m for most use cases
        - **Note:** Files will be saved to `temp_uploads/` for later processing
        """)

        # Create temp_uploads directory if it doesn't exist
        if not os.path.exists(UPLOAD_DIR):
            os.makedirs(UPLOAD_DIR)

        # Use the styled native file uploader
        uploaded_file = styled_file_uploader(min_distance=min_distance)

        # Only save when upload button is clicked
        if uploaded_file is not None:
            if 'upload_clicked' not in st.session_state:
                st.session_state.upload_clicked = False

            if st.session_state.upload_clicked:
                # Use original filename
                file_path = os.path.join(UPLOAD_DIR, uploaded_file.name)

                # Save the file
                try:
                    with open(file_path, "wb") as f:
                        f.write(uploaded_file.getbuffer())

                    st.success("✅ Upload successful")
                    st.session_state.upload_clicked = False

                except Exception as e:
                    st.error(f"❌ Error saving file: {str(e)}")
                    st.session_state.upload_clicked = False

if __name__ == "__main__":
    # Check for existing session first
    check_session()

    # Then run authentication
    user_authentication()

    # Only show the rest of your app if authenticated
    if st.session_state.get("auth_status"):
        main()
