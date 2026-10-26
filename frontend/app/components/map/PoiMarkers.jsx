"use client";

import React, { useState, useEffect } from 'react';
import { Marker, Popup } from 'react-map-gl/maplibre';
import { MdLocationOn } from 'react-icons/md';
import PoiModal from './PoiModal';

const PoiMarkers = ({ pois, hoveredPoiId }) => {
  const [selectedPoi, setSelectedPoi] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [showPopup, setShowPopup] = useState(null);
  const [spreadPois, setSpreadPois] = useState([]);

  // This function distributes POIs that share the same or very similar coordinates
  // in a circular pattern to improve visibility
  useEffect(() => {
    if (!pois || pois.length === 0) {
      setSpreadPois([]);
      return;
    }

    // Group POIs by similar coordinates (within a small threshold)
    const threshold = 0.00001; // Approximately 1 meters
    const groups = [];

    // Create a copy of pois to avoid modifying the original
    const poisCopy = [...pois];

    // Group POIs with similar coordinates
    poisCopy.forEach((poi) => {
      // Check if this POI is close to any existing group center
      const existingGroup = groups.find((group) => {
        const center = group.center;
        return (
          Math.abs(center.latitude - poi.latitude) < threshold &&
          Math.abs(center.longitude - poi.longitude) < threshold
        );
      });

      if (existingGroup) {
        existingGroup.pois.push(poi);
      } else {
        groups.push({
          center: { latitude: poi.latitude, longitude: poi.longitude },
          pois: [poi],
        });
      }
    });

    // For each group, distribute the POIs in a circle if there's more than one
    const spreadPoiResults = [];
    groups.forEach((group) => {
      const { center, pois: groupPois } = group;

      if (groupPois.length === 1) {
        // If only one POI in the group, no need to spread
        spreadPoiResults.push({
          ...groupPois[0],
          spreadLatitude: groupPois[0].latitude,
          spreadLongitude: groupPois[0].longitude,
        });
      } else {
        // Spread multiple POIs in a circle
        const radius = 0.00004 * Math.min(groupPois.length, 8); // ~4 meters * factor based on number of POIs
        groupPois.forEach((poi, index) => {
          // Calculate position on a circle
          const angle = (index / groupPois.length) * Math.PI * 2;
          const offsetX = Math.cos(angle) * radius;
          const offsetY = Math.sin(angle) * radius;

          spreadPoiResults.push({
            ...poi,
            spreadLatitude: center.latitude + offsetY,
            spreadLongitude: center.longitude + offsetX,
            // Add animation delay based on index for staggered effect
            animationDelay: index * 200,
          });
        });
      }
    });

    setSpreadPois(spreadPoiResults);
  }, [pois]);

  // Handler for when a POI marker is clicked
  const handlePoiClick = (poi) => {
    setSelectedPoi(poi);
    setShowModal(true);
    setShowPopup(null); // Hide any open popup
  };

  // Close the modal
  const closeModal = () => {
    setShowModal(false);
  };

  // POI type to color mapping
  const getPoiColor = (poiType) => {
    const typeMap = {
      Restaurant: '#FF5733', // Red-orange
      Cafe: '#C70039', // Darker red
      Bank: '#3498DB', // Blue
      'Retail Store': '#2ECC71', // Green
      Hospital: '#E74C3C', // Red
      Pharmacy: '#9B59B6', // Purple
      School: '#F1C40F', // Yellow
      Office: '#34495E', // Dark blue
      Hotel: '#16A085', // Teal
      ATM: '#2980B9', // Blue
    };

    return typeMap[poiType] || '#FF9800'; // Default orange if type not in map
  };

  return (
    <>
      {spreadPois &&
        spreadPois.map((poi) => (
          <React.Fragment key={poi.id}>
            <Marker
              longitude={poi.spreadLongitude}
              latitude={poi.spreadLatitude}
              anchor='bottom'
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                if (showPopup === poi.id) {
                  handlePoiClick(poi);
                } else {
                  setShowPopup(poi.id);
                }
              }}
            >
              <div
                className={`marker-container ${
                  poi.animationDelay ? 'animated' : ''
                }`}
                style={{
                  animation: poi.animationDelay
                    ? `markerSpread 0.5s ease-out ${poi.animationDelay}ms forwards`
                    : 'none',
                }}
              >
                <MdLocationOn
                  size={hoveredPoiId === poi.id ? 48 : 48}
                  color={getPoiColor(poi.type)}
                  className={`cursor-pointer transition-all drop-shadow-lg
                  ${
                    hoveredPoiId === poi.id
                      ? 'scale-125 drop-shadow-xl'
                      : 'hover:scale-110'
                  }`}
                />
              </div>
            </Marker>

            {/* Show a small popup with basic info */}
            {showPopup === poi.id && (
              <Popup
                longitude={poi.spreadLongitude}
                latitude={poi.spreadLatitude}
                anchor='top'
                closeButton={true}
                closeOnClick={false}
                onClose={() => setShowPopup(null)}
                className='poi-popup z-20'
                maxWidth='200px'
              >
                <div className='p-1'>
                  <p className='text-sm font-semibold text-slate-900'>
                    {poi.text}
                  </p>
                  <p className='text-xs text-slate-600'>{poi.type}</p>
                  <button
                    className='text-xs text-emerald-600 hover:text-emerald-800 mt-1 font-medium'
                    onClick={() => handlePoiClick(poi)}
                  >
                    More details
                  </button>
                </div>
              </Popup>
            )}
          </React.Fragment>
        ))}

      {/* POI Modal */}
      {selectedPoi && (
        <PoiModal poi={selectedPoi} isOpen={showModal} onClose={closeModal} />
      )}
    </>
  );
};

export default PoiMarkers;
