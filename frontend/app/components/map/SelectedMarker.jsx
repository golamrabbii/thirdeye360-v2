"use client";

import React, { useState, useEffect } from 'react';
import { Marker } from 'react-map-gl/maplibre';

const SelectedMarker = ({ feature, isCompact }) => {
  // Add state to track coordinates
  const [markerCoordinates, setMarkerCoordinates] = useState({
    longitude: feature.geometry.coordinates[0],
    latitude: feature.geometry.coordinates[1],
  });

  // Update marker coordinates when feature changes
  useEffect(() => {
    if (feature && feature.geometry && feature.geometry.coordinates) {
      setMarkerCoordinates({
        longitude: feature.geometry.coordinates[0],
        latitude: feature.geometry.coordinates[1],
      });
    }
  }, [feature]);

  // Only render if we have valid coordinates
  if (!markerCoordinates.longitude || !markerCoordinates.latitude) return null;

  return (
    <Marker
      // Using feature ID in key to force re-render when feature changes
      key={`marker-${feature.properties.id}-${feature.geometry.coordinates[0]}-${feature.geometry.coordinates[1]}`}
      longitude={markerCoordinates.longitude}
      latitude={markerCoordinates.latitude}
      anchor='bottom'
      pitchAlignment='map'
    >
      <div
        className={`marker selected-marker scale-in ${
          isCompact ? 'compact' : ''
        }`}
      >
        <div className='marker-pin' />
      </div>
    </Marker>
  );
};

export default SelectedMarker;
