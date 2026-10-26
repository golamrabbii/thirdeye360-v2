// Simplified data hook
"use client";

import { useState, useEffect, useCallback } from "react";

// Default empty data structure
const emptyGeoJSON = {
  type: "FeatureCollection",
  features: [],
};

// Custom hook to fetch and format image data
export function useImageData() {
  const [imageData, setImageData] = useState(emptyGeoJSON);
  const [imagePath, setImagePath] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(Date.now());

  // Function to manually refresh data if needed
  const refreshData = useCallback(() => {
    // This is mostly a placeholder since MBTiles data refreshes directly
    // without needing to fetch from an API
    setLastRefreshed(Date.now());
    return Promise.resolve();
  }, []);

  // For backward compatibility, initialize with empty data
  // Real data comes directly from MBTiles in the MapComponent
  useEffect(() => {
    setIsLoading(false);
    setLastRefreshed(Date.now());
  }, []);

  return {
    imageData,
    imagePath,
    isLoading,
    error,
    refreshData,
    lastRefreshed,
  };
}
