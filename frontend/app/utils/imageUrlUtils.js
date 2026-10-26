/**
 * Image URL Utilities for ThirdEye360
 * Handles R2, Google Drive, and other image sources with proper proxy
 */

import { API_BASE_URL } from '../config/api';

/**
 * Get API base URL based on environment
 * @returns {string} API base URL
 */
export const getApiBaseUrl = () => API_BASE_URL;

/**
 * Generate proxied image URL for any feature
 * Works with R2, Google Drive, or any image source
 * @param {string} featureId - Feature ID (e.g., "0_1", "103_414")
 * @param {string} quality - Image quality: "high" or "comp" (default: "comp")
 * @returns {string} Proxied image URL
 */
export const getProxiedImageUrl = (featureId, quality = 'comp') => {
  if (!featureId) return '';

  const apiBase = getApiBaseUrl();
  return `${apiBase}/api/drive-proxy/${featureId}?quality=${quality}`;
};

/**
 * Generate R2-specific proxied image URL
 * Only works if image is migrated to R2
 * @param {string} featureId - Feature ID
 * @param {string} quality - Image quality: "high" or "comp" (default: "comp")
 * @returns {string} R2-proxied image URL
 */
export const getR2ProxiedImageUrl = (featureId, quality = 'comp') => {
  if (!featureId) return '';

  const apiBase = getApiBaseUrl();
  return `${apiBase}/api/r2-image/${featureId}?quality=${quality}`;
};

/**
 * Determine if a URL is an R2 presigned URL
 * @param {string} url - URL to check
 * @returns {boolean} True if R2 presigned URL
 */
export const isR2PresignedUrl = (url) => {
  if (!url) return false;
  return url.includes('.r2.cloudflarestorage.com') ||
         url.includes('.r2.dev');
};

/**
 * Extract feature ID from R2 URL
 * @param {string} r2Url - R2 presigned URL
 * @returns {string|null} Feature ID or null
 */
export const extractFeatureIdFromR2Url = (r2Url) => {
  if (!r2Url || !isR2PresignedUrl(r2Url)) return null;

  // Extract from path like: /track0/0_1.jpg or /track0/0_1_comp.jpg
  const match = r2Url.match(/\/track\d+\/(\d+_\d+)(?:_comp)?\.jpg/);
  if (match && match[1]) {
    return match[1];
  }
  return null;
};

/**
 * Convert direct R2 URL to proxied URL
 * Useful when you have a direct R2 URL and want to avoid CORS
 * @param {string} r2Url - Direct R2 URL
 * @returns {string} Proxied URL
 */
export const r2UrlToProxy = (r2Url) => {
  const featureId = extractFeatureIdFromR2Url(r2Url);

  if (featureId) {
    // Determine quality from URL
    const isComp = r2Url.includes('_comp.jpg');
    const quality = isComp ? 'comp' : 'high';
    return getProxiedImageUrl(featureId, quality);
  }

  // If we can't extract feature ID, return original URL
  return r2Url;
};

/**
 * Get the best image URL for display
 * Tries R2 direct first (if CORS allows), falls back to proxy
 * @param {object} properties - Image properties from API
 * @param {boolean} isHD - Whether HD mode is enabled
 * @returns {string} Best available image URL
 */
export const getBestImageUrl = (properties, isHD = false) => {
  // Try R2 URL first (if available)
  const r2Url = isHD ? properties.r2Url_High : properties.r2Url_Comp;

  if (r2Url && isR2PresignedUrl(r2Url)) {
    // For production with proper CORS, use direct R2 URL
    // For local development, you might want to use proxy to avoid CORS
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      // Local development: use proxy to avoid CORS
      const featureId = properties.id;
      const quality = isHD ? 'high' : 'comp';
      return getProxiedImageUrl(featureId, quality);
    }
    // Production: use direct R2 URL (faster)
    return r2Url;
  }

  // Fallback to direct URL
  const directUrl = isHD
    ? properties.imageUrl_High || properties.imageUrl
    : properties.imageUrl_Comp || properties.imageUrl;

  return directUrl || '';
};

/**
 * Export all utilities as a single object for easy importing
 */
export const imageUrlUtils = {
  getApiBaseUrl,
  getProxiedImageUrl,
  getR2ProxiedImageUrl,
  isR2PresignedUrl,
  extractFeatureIdFromR2Url,
  r2UrlToProxy,
  getBestImageUrl,
};
