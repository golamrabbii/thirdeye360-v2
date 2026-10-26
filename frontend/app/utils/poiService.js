"use client";

import { apiUrl } from '../config/api';

/**
 * Fetch Points of Interest (POIs) near a specific location
 * @param {number} lat - Latitude of the center point
 * @param {number} lon - Longitude of the center point
 * @param {number} radius - Search radius in meters (default: 5)
 * @returns {Promise<Object>} - The POIs data
 */
export const fetchPointsOfInterest = async (lat, lon, radius = 5) => {
  try {
    const response = await fetch(
      `${apiUrl('/api/point-of-interest')}?lat=${lat}&lon=${lon}&rad=${radius}`
    );

    if (!response.ok) {
      throw new Error(`API response error: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching POIs:", error);
    throw error;
  }
};
