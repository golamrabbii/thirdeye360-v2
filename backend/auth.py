import psycopg2
import bcrypt
import logging
import random
from datetime import datetime, timedelta
from functions import get_db_connection
from streamlit_cookies_controller import CookieController
import streamlit as st

logger = logging.getLogger(__name__)

def get_cookie_controller():
    # Ensure per-session cookie controller
    if 'cookie_controller' not in st.session_state:
        st.session_state.cookie_controller = CookieController(key='auth_cookies')
    return st.session_state.cookie_controller

def create_users_table():
    conn = get_db_connection()
    if not conn: return False
    cur = conn.cursor()
    try:
        cur.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255),
                email VARCHAR(255) UNIQUE,
                username VARCHAR(255) UNIQUE,
                password_hash VARCHAR(255),
                mobile VARCHAR(11),
                otp VARCHAR(6),
                otp_expiry TIMESTAMP
            )
        ''')
        cur.execute('''
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                token VARCHAR(255) UNIQUE,
                expiry TIMESTAMP,
                used BOOLEAN DEFAULT FALSE
            )
        ''')
        conn.commit()
        return True
    except Exception as e:
        logger.error(f"Error creating users table: {str(e)}")
        conn.rollback()
        return False
    finally:
        conn.close()

def register_user(name, email, username, password, mobile=None):
    create_users_table()
    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    conn = get_db_connection()
    if not conn: return False, "Database error"
    cur = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO users (name, email, username, password_hash, mobile) VALUES (%s, %s, %s, %s, %s)",
            (name, email, username, password_hash, mobile)
        )
        conn.commit()
        return True, "Registration successful"
    except psycopg2.errors.UniqueViolation:
        conn.rollback()
        return False, "Username or email already exists"
    except Exception as e:
        conn.rollback()
        logger.error(f"Registration error: {e}")
        return False, "Registration failed"
    finally:
        conn.close()

def login_user(username, password):
    conn = get_db_connection()
    if not conn: return False, "Database error"
    cur = conn.cursor()
    try:
        cur.execute("SELECT id, password_hash, name, email, mobile FROM users WHERE username=%s", (username,))
        row = cur.fetchone()
        if row:
            user_id, password_hash, name, email, mobile = row
            if bcrypt.checkpw(password.encode(), password_hash.encode()):
                cookie_controller = get_cookie_controller()
                # Set cookie with longer expiration (e.g., 7 days)
                cookie_controller.set("user_id", user_id, max_age=604800)
                return True, {
                    "id": user_id,
                    "username": username,
                    "name": name,
                    "email": email,
                    "mobile": mobile
                }
        return False, "Invalid username or password"
    except Exception as e:
        logger.error(f"Login error: {e}")
        return False, "Login failed"
    finally:
        conn.close()

def update_user(user_id, name=None, email=None, username=None, password=None, mobile=None):
    conn = get_db_connection()
    if not conn: return False, "Database error"
    cur = conn.cursor()
    try:
        update_fields = []
        params = []
        if name:
            update_fields.append("name=%s")
            params.append(name)
        if email:
            update_fields.append("email=%s")
            params.append(email)
        if username:
            update_fields.append("username=%s")
            params.append(username)
        if password:
            password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
            update_fields.append("password_hash=%s")
            params.append(password_hash)
        if mobile:
            update_fields.append("mobile=%s")
            params.append(mobile)
        if not update_fields:
            return False, "No fields to update"

        params.append(user_id)
        query = f"UPDATE users SET {', '.join(update_fields)} WHERE id=%s"
        cur.execute(query, tuple(params))
        conn.commit()
        return True, "Update successful"
    except psycopg2.errors.UniqueViolation:
        conn.rollback()
        return False, "Username or email already exists"
    except Exception as e:
        conn.rollback()
        logger.error(f"Update error: {e}")
        return False, "Update failed"
    finally:
        conn.close()

def generate_otp(user_identifier):
    conn = get_db_connection()
    if not conn: return False, "Database error"
    cur = conn.cursor()
    try:
        cur.execute("SELECT id FROM users WHERE email=%s OR mobile=%s", (user_identifier, user_identifier))
        user = cur.fetchone()
        if not user:
            return False, "User not found"
        user_id = user[0]
        otp = str(random.randint(100000, 999999))
        expiry = datetime.now() + timedelta(minutes=10)
        cur.execute(
            "UPDATE users SET otp=%s, otp_expiry=%s WHERE id=%s",
            (otp, expiry, user_id)
        )
        conn.commit()
        logger.info(f"OTP for user {user_id}: {otp}")
        return True, "OTP generated successfully"
    except Exception as e:
        conn.rollback()
        logger.error(f"OTP generation error: {e}")
        return False, "Failed to generate OTP"
    finally:
        conn.close()

def verify_otp(user_identifier, otp):
    conn = get_db_connection()
    if not conn: return False, "Database error"
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT id, otp, otp_expiry FROM users WHERE email=%s OR mobile=%s",
            (user_identifier, user_identifier)
        )
        user = cur.fetchone()
        if not user:
            return False, "User not found"
        user_id, stored_otp, expiry = user
        if not stored_otp or not expiry:
            return False, "OTP not generated or expired"
        if datetime.now() > expiry:
            return False, "OTP expired"
        if stored_otp != otp:
            return False, "Invalid OTP"
        cur.execute("SELECT id, username, name, email, mobile FROM users WHERE id=%s", (user_id,))
        user_data = cur.fetchone()
        return True, {
            "id": user_data[0],
            "username": user_data[1],
            "name": user_data[2],
            "email": user_data[3],
            "mobile": user_data[4]
        }
    except Exception as e:
        logger.error(f"OTP verification error: {e}")
        return False, "OTP verification failed"
    finally:
        conn.close()

def reset_password(user_id, new_password):
    conn = get_db_connection()
    if not conn: return False, "Database error"
    cur = conn.cursor()
    try:
        password_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
        cur.execute(
            "UPDATE users SET password_hash=%s, otp=NULL, otp_expiry=NULL WHERE id=%s",
            (password_hash, user_id)
        )
        conn.commit()
        return True, "Password reset successfully"
    except Exception as e:
        conn.rollback()
        logger.error(f"Password reset error: {e}")
        return False, "Failed to reset password"
    finally:
        conn.close()

def check_session():
    cookie_controller = get_cookie_controller()
    user_id = cookie_controller.get("user_id")
    if user_id:
        if not st.session_state.get("auth_status"):
            conn = get_db_connection()
            if conn:
                try:
                    cur = conn.cursor()
                    cur.execute("SELECT id, username, name, email, mobile FROM users WHERE id=%s", (user_id,))
                    user_data = cur.fetchone()
                    if user_data:
                        st.session_state.auth_status = True
                        st.session_state.user_info = {
                            "id": user_data[0],
                            "username": user_data[1],
                            "name": user_data[2],
                            "email": user_data[3],
                            "mobile": user_data[4]
                        }
                        st.session_state["user_id"] = user_id
                except Exception as e:
                    logger.error(f"Session restore error: {e}")
                finally:
                    conn.close()

def user_authentication():
    from auth import(
        register_user,reset_password,
        login_user, generate_otp, verify_otp,
        update_user
    )
    # Initialize session state variables
    if "auth_status" not in st.session_state:
        st.session_state.auth_status = None
    if "user_info" not in st.session_state:
        st.session_state.user_info = None
    if "show_update_profile" not in st.session_state:
        st.session_state.show_update_profile = False
    if "fastapi_started" not in st.session_state:
        st.session_state.fastapi_started = False
    if "recovery_in_progress" not in st.session_state:
        st.session_state.recovery_in_progress = False
    if "recovery_identifier" not in st.session_state:
        st.session_state.recovery_identifier = None
    if "recovery_identifier_value" not in st.session_state:
        st.session_state.recovery_identifier_value = None
    if "upload_start_time_zip" not in st.session_state:
        st.session_state.upload_start_time_zip = None
    if "upload_start_time_images" not in st.session_state:
        st.session_state.upload_start_time_images = None

    check_session()
    cookie_controller = get_cookie_controller()

    # --- Authentication UI ---
    if not st.session_state.get("auth_status"):
        tabs = st.tabs(["Login", "Register"])
        with tabs[0]:  # Login tab
            st.header("Login")
            login_username = st.text_input("Username", key="login_username")
            login_password = st.text_input("Password", type="password", key="login_password")

            if st.button("Login"):
                success, result = login_user(login_username, login_password)
                if success:
                    st.session_state.auth_status = True
                    st.session_state.user_info = result
                    user_id = result['id']
                    cookie_controller.set("user_id", user_id, max_age=604800)
                    st.session_state.user_id = user_id
                    st.success(f"Welcome, {result['username']}!")
                    import time; time.sleep(0.5)
                    st.rerun()
                else:
                    st.error(result)
            # Forgot password section
            if st.checkbox("Forgot Password?"):
                with st.expander("Password Recovery", expanded=True):
                    recovery_method = st.radio(
                        "Recover via:",
                        ["Email", "Mobile"],
                        horizontal=True,
                        key="recovery_method"
                    )
                    recovery_input = st.text_input(
                        "Enter your registered email" if recovery_method == "Email" else "Enter your registered mobile number",
                        key="recovery_input"
                    )
                    if st.button("Send OTP", key="send_otp"):
                        if not recovery_input:
                            st.error("Please enter your email or mobile number")
                        else:
                            success, message = generate_otp(recovery_input)
                            if success:
                                st.success(f"OTP sent to your {recovery_method.lower()}!")
                                st.session_state.recovery_identifier_value = recovery_input
                                st.session_state.recovery_in_progress = True
                                st.rerun()
                            else:
                                st.error(message)
                    if st.session_state.recovery_in_progress:
                        otp = st.text_input("Enter OTP", max_chars=6, key="recovery_otp")
                        new_password = st.text_input("New Password", type="password", key="new_password")
                        confirm_password = st.text_input("Confirm Password", type="password", key="confirm_password")
                        if st.button("Reset Password", key="reset_password"):
                            if not otp or len(otp) != 6:
                                st.error("Please enter a valid 6-digit OTP")
                            elif not new_password:
                                st.error("Please enter a new password")
                            elif new_password != confirm_password:
                                st.error("Passwords don't match!")
                            else:
                                otp_success, otp_result = verify_otp(
                                    st.session_state.recovery_identifier_value,
                                    otp
                                )
                                if otp_success:
                                    reset_success, reset_message = reset_password(
                                        otp_result["id"],
                                        new_password
                                    )
                                    if reset_success:
                                        st.success("Password reset successfully! You can now login with your new password.")
                                        st.session_state.recovery_in_progress = False
                                        st.session_state.recovery_identifier_value = None
                                        st.rerun()
                                    else:
                                        st.error(reset_message)
                                else:
                                    st.error(otp_result)
        with tabs[1]:  # Register tab
            st.header("Register")
            reg_name = st.text_input("Name", key="reg_name")
            reg_email = st.text_input("Email", key="reg_email")
            reg_username = st.text_input("Username", key="reg_username")
            reg_password = st.text_input("Password", type="password", key="reg_password")
            reg_mobile = st.text_input("Mobile Number (optional)", key="reg_mobile",
                                      help="11 digit mobile number for password recovery")
            if st.button("Register"):
                mobile = reg_mobile.strip() if reg_mobile else None
                if mobile and (not mobile.isdigit() or len(mobile) != 11):
                    st.error("Mobile number must be 11 digits")
                else:
                    success, msg = register_user(
                        reg_name, reg_email, reg_username, reg_password, mobile
                    )
                    if success:
                        st.success(msg)
                    else:
                        st.error(msg)
        st.warning("Please login to access the rest of the app.")
        st.stop()
    else:
        # USER IS LOGGED IN - SIMPLIFIED UI
        st.sidebar.header("User Profile")
        st.sidebar.write(f"Welcome, {st.session_state.user_info['username']}")
        if st.sidebar.button("Update Profile"):
            st.session_state.show_update_profile = not st.session_state.show_update_profile
            st.rerun()
        if st.sidebar.button("Logout"):
            # Clear all session state
            for key in list(st.session_state.keys()):
                del st.session_state[key]
            # Clear cookie
            cookie_controller.set("user_id", "", max_age=0)
            st.rerun()
        if st.session_state.show_update_profile:
            with st.sidebar.expander("Update Profile Details", expanded=True):
                upd_name = st.text_input("New Name",
                                         value=st.session_state.user_info["name"],
                                         key="upd_name")
                upd_email = st.text_input("New Email",
                                          value=st.session_state.user_info["email"],
                                          key="upd_email")
                upd_username = st.text_input("New Username",
                                             value=st.session_state.user_info["username"],
                                             key="upd_username")
                upd_mobile = st.text_input("Mobile Number",
                                           value=st.session_state.user_info.get("mobile", ""),
                                           key="upd_mobile")
                upd_password = st.text_input("New Password",
                                             type="password",
                                             key="upd_password",
                                             placeholder="Leave empty to keep current password")
                col1, col2 = st.columns(2)
                with col1:
                    if st.button("Save Changes"):
                        mobile = upd_mobile.strip() if upd_mobile else None
                        if mobile and (not mobile.isdigit() or len(mobile) != 11):
                            st.error("Mobile number must be 11 digits")
                        else:
                            success, msg = update_user(
                                st.session_state.user_info["id"],
                                name=upd_name,
                                email=upd_email,
                                username=upd_username,
                                password=upd_password if upd_password else None,
                                mobile=mobile
                            )
                            if success:
                                st.session_state.user_info = {
                                    **st.session_state.user_info,
                                    "name": upd_name,
                                    "email": upd_email,
                                    "username": upd_username,
                                    "mobile": mobile
                                }
                                st.success(msg)
                                st.session_state.show_update_profile = False
                                st.rerun()
                            else:
                                st.error(msg)
                with col2:
                    if st.button("Cancel"):
                        st.session_state.show_update_profile = False
                        st.rerun()