/**
 * Barikoi Authentication Module
 * Handles authentication for ThirdEye360 application
 */

import { apiUrl } from "../config/api";

const TOKEN_KEY = "thirdeye_auth_token";
const USER_KEY = "thirdeye_auth_user";

class BarikoiAuth {
  constructor() {
    this.baseURL = "https://api.admin.barikoi.com/api/v2";
    this.isAuthenticating = false;
    this.isAuthenticated = false;
    this.user = null;
    this.token = null;
    this.permissions = [];

    this.listeners = {
      login: [],
      logout: [],
      authStateChange: [],
      error: [],
    };

    this.initializeAuth();
  }

  initializeAuth() {
    if (typeof window === "undefined") return;

    const token = localStorage.getItem(TOKEN_KEY);
    const userStr = localStorage.getItem(USER_KEY);

    if (token && userStr) {
      try {
        const user = JSON.parse(userStr);
        this.token = token;
        this.user = user;
        this.permissions = user.all_permissions || [];
        this.isAuthenticated = true;

        // Admin permission is re-checked on every session restore: the flag
        // persisted at login goes stale when the admin row changes afterwards
        // or when the check failed at login (e.g. the API was unreachable
        // from that device). Fails closed; the UI refreshes when it returns.
        this.fetchAdminPermission(token, user).then((updated) => {
          this.user = updated;
          if (typeof window !== "undefined") {
            localStorage.setItem(USER_KEY, JSON.stringify(updated));
          }
          this.notifyListeners("authStateChange", {
            isAuthenticating: false,
            isAuthenticated: true,
            user: updated,
            token,
          });
        });
      } catch (error) {
        console.error("Error parsing user data:", error);
        this.clearAuth();
      }
    }
  }

  async login(email, password) {
    this.isAuthenticating = true;
    this.notifyListeners("authStateChange", { isAuthenticating: true });

    try {
      const response = await this.makeRequest(`${this.baseURL}/login`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.data) {
        throw new Error("Token not found in response");
      }

      const token = response.data;
      const result = await this.validateToken(token);

      this.isAuthenticating = false;
      this.notifyListeners("login", { user: this.user, token: this.token });
      this.notifyListeners("authStateChange", {
        isAuthenticating: false,
        isAuthenticated: true,
        user: this.user,
        token: this.token,
      });

      return result;
    } catch (error) {
      this.isAuthenticating = false;
      this.isAuthenticated = false;
      this.notifyListeners("error", {
        type: "login",
        message: error.message,
        error,
      });
      this.notifyListeners("authStateChange", {
        isAuthenticating: false,
        isAuthenticated: false,
        error: error.message,
      });
      throw error;
    }
  }

  async validateToken(token) {
    if (!token) {
      throw new Error("No token provided");
    }

    try {
      const response = await this.makeRequest(`${this.baseURL}/auth/user`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.user) {
        throw new Error("User not found in response");
      }

      const { user } = response;

      // Ask the ThirdEye360 backend whether this Barikoi user has admin
      // permission (upload/delete rights) before persisting the session.
      // Fails closed: on any error user.isAdmin is false.
      await this.fetchAdminPermission(token, user);

      if (typeof window !== "undefined") {
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(USER_KEY, JSON.stringify(user));
      }

      this.token = token;
      this.user = user;
      this.permissions = user.all_permissions || [];
      this.isAuthenticated = true;

      return { user, token };
    } catch (error) {
      this.clearAuth();
      throw error;
    }
  }

  /**
   * Ask the ThirdEye360 backend whether the authenticated Barikoi user has
   * admin permission. Attaches `isAdmin` (and the verified `barikoi_id`)
   * onto `user` so the caller can persist it with the session. Fails
   * closed: any error leaves isAdmin false.
   */
  async fetchAdminPermission(token, user) {
    try {
      const response = await this.makeRequest(apiUrl("/api/auth/permission"), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      user.isAdmin = !!response.is_admin;
      if (response.barikoi_id != null) {
        user.barikoi_id = response.barikoi_id;
      }
    } catch (error) {
      console.error("Admin permission check failed:", error.message);
      user.isAdmin = false;
    }
    return user;
  }

  logout() {
    this.isAuthenticating = true;

    if (typeof window !== "undefined") {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }

    this.clearAuth();

    this.notifyListeners("logout", {});
    this.notifyListeners("authStateChange", {
      isAuthenticating: false,
      isAuthenticated: false,
      user: null,
      token: null,
    });
  }

  clearAuth() {
    this.isAuthenticating = false;
    this.isAuthenticated = false;
    this.user = null;
    this.token = null;
    this.permissions = [];
  }

  hasPermission(permission) {
    if (!this.permissions || this.permissions.length === 0) {
      return false;
    }
    return this.permissions.includes(permission);
  }

  getAuthState() {
    return {
      isAuthenticated: this.isAuthenticated,
      isAuthenticating: this.isAuthenticating,
      user: this.user,
      token: this.token,
      permissions: this.permissions,
    };
  }

  async makeRequest(url, options = {}) {
    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.message || `HTTP error! status: ${response.status}`
        );
      }

      return await response.json();
    } catch (error) {
      console.error("Request failed:", error);
      throw error;
    }
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(
        (cb) => cb !== callback
      );
    }
  }

  notifyListeners(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((callback) => {
        try {
          callback(data);
        } catch (error) {
          console.error("Error in event listener:", error);
        }
      });
    }
  }
}

let authInstance = null;

export const getAuthInstance = () => {
  if (!authInstance) {
    authInstance = new BarikoiAuth();
  }
  return authInstance;
};

export const TOKEN_KEY_EXPORT = TOKEN_KEY;
export const USER_KEY_EXPORT = USER_KEY;

export default BarikoiAuth;
