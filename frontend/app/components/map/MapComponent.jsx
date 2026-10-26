"use client";

import React, { useState, useCallback, useEffect, useRef } from 'react';
import Map, {
  Source,
  Layer,
  NavigationControl,
  ScaleControl,
  AttributionControl,
  Marker,
  Popup,
} from 'react-map-gl/maplibre';
import {
  FaMapPin,
  FaTrashAlt,
  FaCrosshairs,
  FaPlus,
  FaMinus,
  FaLocationArrow,
  FaExpand,
  FaCompress,
  FaRoute,
} from 'react-icons/fa';
import SelectedMarker from './SelectedMarker';
import PoiMarkers from './PoiMarkers'; // Import the PoiMarkers component
import PoiSidebar from './PoiSidebar'; // Import the PoiSidebar component
import DeletePointsModal from './DeletePointsModal'; // Import the new delete modal
import DeleteMarkers from './DeleteMarkers'; // Import the delete markers component
import PolygonDeletePanel from './PolygonDeletePanel'; // Import the polygon delete panel
import 'maplibre-gl/dist/maplibre-gl.css';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import MapSearchBar from '../ui/MapSearchBar';
import { fetchPointsOfInterest } from '../../utils/poiService'; // Import the POI service
import {
  fetchCoverageLines,
  nearestPointOnTrack,
} from '../../utils/coverageLines';
import { copyToClipboard } from '../../utils/clipboard';
import { apiUrl } from '../../config/api';
import { TiMediaPlayOutline } from 'react-icons/ti';

// Mockup-style switch row used inside the Layer Controls card
const SwitchRow = ({
  id,
  label,
  checked,
  onChange,
  iconBoxClass,
  labelClass,
  accentClass,
  children,
}) => (
  <div className='flex items-center justify-between group'>
    <div className='flex items-center space-x-2.5'>
      <div
        className={`w-7 h-7 rounded-lg flex items-center justify-center border ${iconBoxClass}`}
      >
        {children}
      </div>
      <label htmlFor={id} className={`cursor-pointer select-none ${labelClass}`}>
        {label}
      </label>
    </div>
    <label className='relative inline-flex items-center cursor-pointer'>
      <input
        id={id}
        type='checkbox'
        className='sr-only peer'
        checked={checked}
        onChange={onChange}
      />
      <div
        className={
          'w-10 h-5 bg-slate-200 dark:bg-slate-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-[20px] peer-checked:after:border-white after:content-[""] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all shadow-inner ' +
          accentClass
        }
      ></div>
    </label>
  </div>
);

const MapComponent = ({
  imageData,
  selectedImageId,
  onImageSelect,
  isCompact = false,
  fullBleed = false,
  customMapStyle = null,
  refreshData,
  isLoading,
  initialViewState = null, // Add initialViewState prop with default value of null
  followTarget = null, // { longitude, latitude } — glide here when it changes (minimap)
  selectedImage,
}) => {
  const { darkMode } = useTheme();
  const { isAdmin } = useAuth(); // delete controls are admin-only
  const [showPoints, setShowPoints] = useState(true); // State to control points layer visibility
  // Street trajectory lines (built client-side from the all-images data).
  // Off by default — the vector-tile dots are the default display; flipping
  // the "Lines" toggle converts them into trajectories.
  const [showLines, setShowLines] = useState(false);
  const [linesLoading, setLinesLoading] = useState(false);
  const [coverageLines, setCoverageLines] = useState(null);
  const coveragePointsRef = useRef(null);

  // State for search pin location
  const [searchPinLocation, setSearchPinLocation] = useState(null);
  const [showSearchPopup, setShowSearchPopup] = useState(false);

  // State to track the selected feature from vector tiles
  const [selectedFeature, setSelectedFeature] = useState(null);

  // State for coordinate type toggle (snapped vs original)
  const [useSnappedCoordinates, setUseSnappedCoordinates] = useState(true);

  // State for right-click coordinates popup
  const [rightClickCoords, setRightClickCoords] = useState(null);
  const [showCoordsPopup, setShowCoordsPopup] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  // State for POI mode
  const [poiMode, setPoiMode] = useState(false);
  const [pois, setPois] = useState(null);
  const [isLoadingPois, setIsLoadingPois] = useState(false);
  const [poiSearchRadius, setPoiSearchRadius] = useState(5); // Default radius in meters

  // State for POI hover and sidebar
  const [hoveredPoiId, setHoveredPoiId] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  // State for delete mode
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedPointsForDeletion, setSelectedPointsForDeletion] = useState(
    []
  );
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeletingPoints, setIsDeletingPoints] = useState(false);

  // State for polygon delete mode
  const [polygonDeleteMode, setPolygonDeleteMode] = useState(false);
  const [polygonPoints, setPolygonPoints] = useState([]);
  const [showPolygonPanel, setShowPolygonPanel] = useState(false);
  const [mapInstance, setMapInstance] = useState(null);

  // v2 floating map chrome (toolbox / fullscreen / my-location)
  const mapRef = useRef(null);
  const wrapperRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [userLocation, setUserLocation] = useState(null);

  // Helper function to get coordinates based on toggle state
  const getCoordinates = useCallback(
    (feature) => {
      if (!feature?.properties) return [0, 0];

      // Use snapped coordinates if available and toggle is on
      if (
        useSnappedCoordinates &&
        feature.properties.longitude_snapped !== undefined &&
        feature.properties.latitude_snapped !== undefined
      ) {
        return [
          feature.properties.longitude_snapped,
          feature.properties.latitude_snapped,
        ];
      }

      // Fall back to original coordinates
      return feature.geometry.coordinates;
    },
    [useSnappedCoordinates]
  );

  // Lines replace the dots only when the toggle is on AND geometry is loaded
  const linesActive = showLines && coverageLines;

  // Get layer IDs for interactive layers - the ThirdEye vector tile layer
  const interactiveLayerIds = linesActive
    ? ['ThirdEye360', 'coverage-line-hit']
    : ['ThirdEye360'];

  // Lazily load the trajectory geometry the first time "Lines" is enabled
  // (main map only). Dots stay on until the data is ready. On failure the
  // vector-tile dots remain as the display; retry on next toggle.
  useEffect(() => {
    if (isCompact || !showLines || coverageLines) return undefined;
    let active = true;
    setLinesLoading(true);
    fetchCoverageLines()
      .then((result) => {
        if (!active) return;
        if (result) {
          setCoverageLines(result.lines);
          coveragePointsRef.current = result.pointsByTrack;
        }
      })
      .catch(() => {
        // dots stay as fallback; retry on next toggle
      })
      .finally(() => {
        if (active) setLinesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isCompact, showLines, coverageLines]);

  // Toggle delete mode
  const toggleDeleteMode = () => {
    setDeleteMode((prev) => {
      // If turning off delete mode, clear selected points
      if (prev) {
        setSelectedPointsForDeletion([]);
      }
      // If turning on delete mode, turn off POI mode and polygon delete mode
      if (!prev) {
        if (poiMode) {
          setPoiMode(false);
          setPois(null);
        }
        if (polygonDeleteMode) {
          setPolygonDeleteMode(false);
          setPolygonPoints([]);
          setShowPolygonPanel(false);
        }
      }
      return !prev;
    });
  };

  // Toggle polygon delete mode
  const togglePolygonDeleteMode = () => {
    setPolygonDeleteMode((prev) => {
      if (prev) {
        // Turning off polygon delete mode
        setPolygonPoints([]);
        setShowPolygonPanel(false);
      } else {
        // Turning on polygon delete mode
        setShowPolygonPanel(true);
        // Turn off other modes
        if (poiMode) {
          setPoiMode(false);
          setPois(null);
        }
        if (deleteMode) {
          setDeleteMode(false);
          setSelectedPointsForDeletion([]);
        }
      }
      return !prev;
    });
  };

  // Handle polygon point addition
  const addPolygonPoint = useCallback((lngLat) => {
    setPolygonPoints((prev) => [...prev, [lngLat.lng, lngLat.lat]]);
  }, []);

  // Clear polygon
  const clearPolygon = useCallback(() => {
    setPolygonPoints([]);
  }, []);

  // Undo last polygon point
  const undoLastPolygonPoint = useCallback(() => {
    setPolygonPoints((prev) => prev.slice(0, -1));
  }, []);

  // Close polygon delete panel
  const closePolygonPanel = useCallback(() => {
    setShowPolygonPanel(false);
    setPolygonDeleteMode(false);
    setPolygonPoints([]);
  }, []);

  // Add point to deletion selection
  const addPointForDeletion = (feature) => {
    const point = {
      id: feature.properties.id,
      latitude: feature.geometry.coordinates[1],
      longitude: feature.geometry.coordinates[0],
      // Store additional properties for display
      imageUrl_High: feature.properties.imageUrl_High,
      driveUrl_Comp: feature.properties.imageUrl_Comp,
      capture_date: feature.properties.capture_date,
    };

    setSelectedPointsForDeletion((prev) => {
      // Check if point is already selected
      const exists = prev.find((p) => p.id === point.id);
      if (!exists) {
        return [...prev, point];
      }
      return prev;
    });
  };

  // Remove point from deletion selection
  const removePointFromDeletion = (pointId) => {
    setSelectedPointsForDeletion((prev) =>
      prev.filter((p) => p.id !== pointId)
    );
  };

  // Handle delete confirmation
  const handleDeleteConfirm = async (pointIds) => {
    setIsDeletingPoints(true);
    try {
      const response = await fetch(apiUrl('/api/features/delete-batch'), {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            feature_ids: pointIds,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Delete request failed: ${response.status}`);
      }

      const result = await response.json();
      console.log('Delete result:', result);

      // Clear selected points and turn off delete mode
      setSelectedPointsForDeletion([]);
      setDeleteMode(false);

      // Refresh data if available
      if (refreshData) {
        refreshData();
      }
    } catch (error) {
      console.error('Error deleting points:', error);
      alert(`Failed to delete points: ${error.message}`);
    } finally {
      setIsDeletingPoints(false);
    }
  };

  // Toggle POI mode
  const togglePoiMode = () => {
    setPoiMode((prev) => {
      // If turning on POI mode, automatically expand the sidebar and turn off delete mode
      if (!prev) {
        setSidebarCollapsed(false);
        if (deleteMode) {
          setDeleteMode(false);
          setSelectedPointsForDeletion([]);
        }
        if (polygonDeleteMode) {
          setPolygonDeleteMode(false);
          setPolygonPoints([]);
          setShowPolygonPanel(false);
        }
      }
      return !prev;
    });

    // Clear POIs when turning off POI mode
    if (poiMode) {
      setPois(null);
    }
  };

  // Function to toggle points layer visibility
  const togglePointsVisibility = () => {
    setShowPoints((prev) => !prev);
  };

  // Dynamically set map style based on theme
  const mapStyle =
    customMapStyle ||
    (darkMode
      ? 'https://map.barikoi.com/styles/barikoi-dark-mode/style.json?key=bkoi_ed6171d88adc261e0a937a5649999a16fcbd8808c16f7fa08a9634cb6c41b944'
      : 'https://map.barikoi.com/styles/osm_barikoi_v2/style.json?key=bkoi_ed6171d88adc261e0a937a5649999a16fcbd8808c16f7fa08a9634cb6c41b944');

  // Initialize view state from initialViewState (if provided) or from the first feature in the data
  const [viewState, setViewState] = useState(
    initialViewState || {
      longitude:
        imageData?.features?.[0]?.geometry.coordinates[0] || 90.3938010872331,
      latitude:
        imageData?.features?.[0]?.geometry.coordinates[1] || 23.821600011863,
      zoom: 14,
      pitch: 0,
      bearing: 0,
    }
  );

  // Update the view state when the image data changes
  useEffect(() => {
    // TEMP DEBUG (mini-map jump) — remove after diagnosis
    if (isCompact) console.log('[MINIMAP-DBG] imageData effect entered (guard should skip)');
    // The compact mini-map manages its own camera (initialViewState on mount
    // + followTarget glides per step). Resetting to features[0] here fired on
    // EVERY selection change (the parent passes a fresh imageData object each
    // render), teleporting the camera — and the GPS icon with it — back to
    // the session's start point before the follow glide ran.
    if (isCompact) return;
    if (imageData?.features && imageData.features.length > 0) {
      setViewState((prev) => ({
        ...prev,
        longitude:
          imageData.features[0]?.geometry.coordinates[0] || prev.longitude,
        latitude:
          imageData.features[0]?.geometry.coordinates[1] || prev.latitude,
      }));
    }
  }, [imageData, isCompact]);

  // Update selectedFeature when selectedImageId changes (for marker visibility)
  useEffect(() => {
    // If no selectedImageId, clear the selectedFeature
    if (!selectedImageId) {
      setSelectedFeature(null);
      return;
    }

    // If we have a selected image ID but no existing selectedFeature, or the ID has changed
    if (!selectedFeature || selectedFeature.properties.id !== selectedImageId) {
      // First check if it's in the imageData.features array (old approach)
      const foundInFeatures = imageData?.features?.find(
        (feature) =>
          feature.properties.id === selectedImageId ||
          feature.properties.id === selectedImageId
      );

      if (foundInFeatures) {
        setSelectedFeature(foundInFeatures);
      }
    }
  }, [selectedImageId, imageData, selectedFeature]);

  // Add a useEffect to update selectedFeature when selectedImage prop changes
  useEffect(() => {
    if (
      selectedImage &&
      selectedImage.properties &&
      selectedImage.properties.id
    ) {
      // Update the selectedFeature with the latest selectedImage data
      // Create a new object to ensure React detects the change
      setSelectedFeature({
        ...selectedImage,
        properties: { ...selectedImage.properties },
        geometry: { ...selectedImage.geometry },
      });
    }
  }, [selectedImage]);

  // Handle hovering POI in the sidebar
  const handlePoiHover = (poiId) => {
    setHoveredPoiId(poiId);
  };

  // Handle fetching POIs when in POI mode and user clicks on the map
  const fetchPois = async (lat, lon) => {
    setIsLoadingPois(true);
    try {
      const data = await fetchPointsOfInterest(lat, lon, poiSearchRadius);
      setPois(data.pois);

      // Auto-expand sidebar when POIs are found
      if (data.pois && data.pois.length > 0) {
        setSidebarCollapsed(false);
      }
    } catch (error) {
      console.error('Error fetching POIs:', error);
    } finally {
      setIsLoadingPois(false);
    }
  };

  // Camera helpers for the floating toolbox / quick jump badges
  const getMapLibreMap = () => mapRef.current?.getMap?.() || mapInstance;

  const flyToLocation = useCallback(
    (longitude, latitude, zoom = 16, duration = 1500) => {
      const map = getMapLibreMap();
      if (map) {
        map.flyTo({
          center: [longitude, latitude],
          zoom,
          duration,
          essential: true,
        });
      } else {
        setViewState((prev) => ({
          ...prev,
          longitude,
          latitude,
          zoom,
          transitionDuration: duration,
        }));
      }
    },
    [mapInstance]
  );

  // --- Map-idle panorama prefetch -------------------------------------------
  // NOTE: background map-idle prefetching was removed entirely by user
  // decision — it competed with clicked images on the R2-streaming origin.
  // Clicks fetch their image directly; nothing warms in the background.
  // ---------------------------------------------------------------------------

  // Minimap follow: glide to each newly selected frame so the compact map
  // tracks movement along a street (initialViewState only applies on mount).
  useEffect(() => {
    if (!isCompact || !followTarget || !mapInstance) return undefined;
    const map = getMapLibreMap();
    if (!map || typeof map.easeTo !== 'function') return undefined;
    // TEMP DEBUG (mini-map jump) — remove after diagnosis
    console.log(
      '[MINIMAP-DBG] easeTo ->',
      followTarget.longitude,
      followTarget.latitude
    );
    map.easeTo({
      center: [followTarget.longitude, followTarget.latitude],
      duration: 450,
    });
    return undefined;
  }, [followTarget, isCompact, mapInstance]);

  const onMapClick = useCallback(
    (event) => {
      // Get the map instance from the event
      const map = event.target;

      try {
        // If in polygon delete mode, add point to polygon
        if (polygonDeleteMode) {
          const { lngLat } = event;
          addPolygonPoint(lngLat);
          return;
        }

        // If in POI mode, fetch POIs near the clicked point
        if (poiMode) {
          const { lngLat } = event;
          fetchPois(lngLat.lat, lngLat.lng);
          return;
        }

        // Trajectory lines: clicking a line selects the nearest capture point
        // on that street (lines replace the dots once loaded)
        const lineHits = linesActive
          ? map.queryRenderedFeatures(event.point, {
              layers: ['coverage-line-hit'],
            })
          : [];
        if (lineHits.length > 0) {
          const track = lineHits[0].properties?.track;
          const point = nearestPointOnTrack(
            coveragePointsRef.current,
            track,
            event.lngLat.lng,
            event.lngLat.lat
          );
          if (point?.properties?.id) {
            const pointFeature = {
              properties: point.properties,
              geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
            };
            if (deleteMode) {
              addPointForDeletion(pointFeature);
              return;
            }
            setViewState((prev) => ({
              ...prev,
              longitude: point.lng,
              latitude: point.lat,
              transitionDuration: 500,
            }));
            setSelectedFeature(pointFeature);
            onImageSelect(point.properties);
          }
          return;
        }

        // Use queryRenderedFeatures to get all features at the click point
        const features = map.queryRenderedFeatures(event.point);

        if (features.length > 0) {
          const feature = features[0];
          const featureId = feature.layer.id;

          // Check if user clicked on vector tile layer point (from thirdEye source)
          if (featureId === 'ThirdEye360') {
            if (feature.properties && feature.properties.id) {
              // If in delete mode, add point to selection
              if (deleteMode) {
                addPointForDeletion(feature);
                return;
              }

              // Normal mode - update viewport to center on clicked point
              const [lng, lat] = feature.geometry.coordinates;
              setViewState((prev) => ({
                ...prev,
                longitude: lng,
                latitude: lat,
                // Keep current zoom level
                transitionDuration: 500, // smooth animation in ms
              }));

              // Save the selected feature for marker display
              setSelectedFeature({
                properties: feature.properties,
                geometry: feature.geometry,
              });

              // Pass the entire feature properties instead of just the ID
              onImageSelect(feature.properties);
            }
            return;
          }
        }
      } catch (error) {
        console.error('Error handling map click:', error);
      }
    },
    [onImageSelect, poiMode, poiSearchRadius, deleteMode, polygonDeleteMode, addPolygonPoint, linesActive]
  );

  // Handle copying coordinates to clipboard
  const handleCopyCoords = useCallback(() => {
    if (rightClickCoords) {
      const coordsText = `${rightClickCoords.lat.toFixed(
        6
      )}, ${rightClickCoords.lng.toFixed(6)}`;
      copyToClipboard(coordsText)
        .then(() => {
          setCopySuccess(true);
          // Reset the "Copied!" message after 2 seconds
          setTimeout(() => setCopySuccess(false), 2000);
        })
        .catch((err) => {
          console.error('Failed to copy coordinates: ', err);
        });
    }
  }, [rightClickCoords]);

  const onMapRightClick = useCallback((event) => {
    // Prevent default context menu
    event.preventDefault();

    // Get the coordinates where the user right-clicked
    const { lngLat } = event;

    // Update state to show the coordinates popup
    setRightClickCoords(lngLat);
    setShowCoordsPopup(true);
    // Reset copy success state
    setCopySuccess(false);
  }, []);

  // Handle location selection from search bar
  const handleLocationSelect = (location) => {
    if (location && location.longitude && location.latitude) {
      // Fly to the selected location with animation
      setViewState((prev) => ({
        ...prev,
        longitude: parseFloat(location.longitude),
        latitude: parseFloat(location.latitude),
        zoom: 16, // Zoom in to a good level to see details
        transitionDuration: 1000, // 1 second animation
        transitionEasing: (t) => t * (2 - t), // Ease out effect
      }));

      // Set search pin location and show popup
      setSearchPinLocation(location);
      setShowSearchPopup(true);
    }
  };

  // Toolbox: zoom controls
  const handleZoomIn = () => {
    const map = getMapLibreMap();
    if (map) map.zoomIn();
  };

  const handleZoomOut = () => {
    const map = getMapLibreMap();
    if (map) map.zoomOut();
  };

  // Toolbox: compass reset - animate bearing back to north
  const handleResetBearing = () => {
    const map = getMapLibreMap();
    if (map) {
      map.flyTo({ bearing: 0, duration: 1000, essential: true });
    }
  };

  // Toolbox: my location - geolocate and fly there
  const handleMyLocation = () => {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { longitude, latitude } = position.coords;
        setUserLocation({ longitude, latitude });
        flyToLocation(longitude, latitude, 16);
      },
      (error) => {
        console.error('Error getting user location:', error);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Toolbox: fullscreen on the map wrapper
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (wrapperRef.current?.requestFullscreen) {
      wrapperRef.current.requestFullscreen();
    }
  };

  // Live heading from the current bearing (normalized 0-360)
  const heading = ((((viewState.bearing || 0) % 360) + 360) % 360).toFixed(0);

  return (
    <div
      ref={wrapperRef}
      className={`relative ${
        fullBleed ? 'w-full h-full' : 'rounded-2xl overflow-hidden shadow-lg'
      }`}
    >
      {/* Floating Search Overlay - only on full map, not in compact mode */}
      {!isCompact && (
        <div className='absolute top-4 inset-x-0 z-20 flex flex-col items-center px-3 sm:px-4 pointer-events-none'>
          <div className='w-full max-w-2xl pointer-events-auto space-y-2.5'>
            <MapSearchBar onLocationSelect={handleLocationSelect} />
          </div>
        </div>
      )}

      {/* POI Sidebar - only when not in compact mode */}
      {!isCompact && poiMode && (
        <PoiSidebar
          pois={pois}
          onHover={handlePoiHover}
          activePoiId={hoveredPoiId}
          collapsed={sidebarCollapsed}
          setCollapsed={setSidebarCollapsed}
        />
      )}

      {/* Collapsed sidebar indicator */}
      {!isCompact && poiMode && sidebarCollapsed && pois && pois.length > 0 && (
        <button
          onClick={() => setSidebarCollapsed(false)}
          className='fixed left-0 top-1/2 transform -translate-y-1/2 z-20 bg-emerald-600 text-white py-4 px-2 rounded-r-xl shadow-lg hover:bg-emerald-700 transition-colors'
        >
          <TiMediaPlayOutline></TiMediaPlayOutline>
        </button>
      )}

      <Map
        {...viewState}
        style={{
          width: '100%',
          height: isCompact ? '300px' : fullBleed ? '100%' : '75vh',
        }}
        mapStyle={mapStyle}
        onMove={(evt) => {
          // TEMP DEBUG (mini-map jump) — remove after diagnosis
          if (isCompact)
            console.log(
              '[MINIMAP-DBG] onMove',
              evt.viewState.longitude.toFixed(5),
              evt.viewState.latitude.toFixed(5),
              'z' + evt.viewState.zoom.toFixed(2)
            );
          setViewState(evt.viewState);
        }}
        interactiveLayerIds={interactiveLayerIds}
        onClick={onMapClick}
        onContextMenu={onMapRightClick}
        dragRotate={!isCompact}
        pitchWithRotate={!isCompact}
        attributionControl={false}
        ref={mapRef}
        onLoad={(map) => {
          // Store the map instance. The thirdEye source and its layer are
          // declared declaratively below instead of being added here, so they
          // are re-applied after every style reload (e.g. theme switches).
          // TEMP DEBUG (mini-map jump) — remove after diagnosis
          console.log('[MINIMAP-DBG] map onLoad, isCompact =', isCompact);
          setMapInstance(map.target);
        }}
      >
        {/* Map Controls - custom glass toolbox replaces NavigationControl on the full map */}
        {!isCompact && (
          <>
            <ScaleControl position='bottom-right' />
            <AttributionControl
              position='bottom-left'
              customAttribution='ThirdEye360'
            />
          </>
        )}
        {isCompact && <NavigationControl position='top-right' />}

        {/* Add the vector tile layer from the ThirdEye source.
            Declared declaratively (Source wraps Layer) so react-map-gl
            re-adds the source and layer after every style reload - the
            runtime-added source used to be wiped on dark/light switches. */}
        <Source
          id='thirdEye'
          type='vector'
          url='https://tiles.bmapsbd.com/ThirdEye360'
        >
          {showPoints && !linesActive && (
            <Layer
              id='ThirdEye360'
              type='circle'
              source='thirdEye'
              source-layer='ThirdEye360'
              paint={{
                // Fallback capture-point design (shown until/unless the
                // trajectory lines are available). Radius grows gently with
                // zoom — a nudge per level, clearly larger at street zoom.
                'circle-color': '#10b981',
                'circle-radius': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  8,
                  1.25,
                  12,
                  1.75,
                  14,
                  3,
                  16,
                  4,
                  17,
                  5,
                  18,
                  6,
                  20,
                  7,
                ],
              }}
              filter={['==', ['geometry-type'], 'Point']}
            />
          )}
        </Source>

        {/* StreetView trajectory lines (dot.html/lines.html design):
            glow underlay -> emerald core -> highlight -> white dashes.
            Replaces the vector-tile dots once geometry is loaded. */}
        {linesActive && (
          <Source id='coverage-lines' type='geojson' data={coverageLines}>
            <Layer
              id='coverage-glow'
              type='line'
              paint={{
                'line-color': '#10b981',
                'line-width': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  8,
                  3,
                  12,
                  7,
                  16,
                  13,
                ],
                'line-blur': 4,
                'line-opacity': 0.35,
              }}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            />
            <Layer
              id='coverage-core'
              type='line'
              paint={{
                'line-color': '#059669',
                'line-width': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  8,
                  1.5,
                  12,
                  3,
                  16,
                  5,
                ],
                'line-opacity': 0.9,
              }}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            />
            <Layer
              id='coverage-highlight'
              type='line'
              paint={{
                'line-color': '#34d399',
                'line-width': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  8,
                  0.8,
                  12,
                  1.5,
                  16,
                  2.5,
                ],
              }}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            />
            <Layer
              id='coverage-dashes'
              type='line'
              paint={{
                'line-color': '#ffffff',
                'line-width': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  8,
                  1,
                  12,
                  1.8,
                  16,
                  3,
                ],
                'line-dasharray': [0.5, 7],
                'line-opacity': 0.9,
              }}
            />
            {/* Invisible wide layer that makes the lines easy to click */}
            <Layer
              id='coverage-line-hit'
              type='line'
              paint={{
                'line-color': '#ffffff',
                'line-width': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  8,
                  10,
                  16,
                  24,
                ],
                'line-opacity': 0.001,
              }}
            />
          </Source>
        )}

        {/* Polygon Delete Visualization */}
        {polygonDeleteMode && polygonPoints && polygonPoints.length > 0 && (
          <>
            {/* Polygon fill */}
            <Source
              id='polygon-delete-fill'
              type='geojson'
              data={{
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    polygonPoints.length >= 3
                      ? [...polygonPoints, polygonPoints[0]]
                      : polygonPoints,
                  ],
                },
              }}
            >
              <Layer
                id='polygon-fill-layer'
                type='fill'
                paint={{
                  'fill-color': '#ef4444',
                  'fill-opacity': 0.15,
                }}
              />
            </Source>

            {/* Polygon outline */}
            <Source
              id='polygon-delete-outline'
              type='geojson'
              data={{
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates:
                    polygonPoints.length >= 3
                      ? [...polygonPoints, polygonPoints[0]]
                      : polygonPoints,
                },
              }}
            >
              <Layer
                id='polygon-outline-layer'
                type='line'
                paint={{
                  'line-color': '#ef4444',
                  'line-width': 2,
                  'line-dasharray': [2, 2],
                }}
              />
            </Source>

            {/* Polygon vertices */}
            <Source
              id='polygon-vertices'
              type='geojson'
              data={{
                type: 'FeatureCollection',
                features: polygonPoints.map((coord, idx) => ({
                  type: 'Feature',
                  properties: { index: idx + 1 },
                  geometry: {
                    type: 'Point',
                    coordinates: coord,
                  },
                })),
              }}
            >
              <Layer
                id='polygon-vertices-layer'
                type='circle'
                paint={{
                  'circle-radius': 6,
                  'circle-color': '#ef4444',
                  'circle-stroke-width': 2,
                  'circle-stroke-color': '#ffffff',
                }}
              />
              {polygonPoints.length >= 1 && (
                <Layer
                  id='polygon-vertices-labels'
                  type='symbol'
                  layout={{
                    'text-field': ['get', 'index'],
                    'text-offset': [0, 0],
                    'text-anchor': 'center',
                    'text-size': 10,
                  }}
                  paint={{
                    'text-color': '#ffffff',
                  }}
                />
              )}
            </Source>
          </>
        )}

        {/* Selected Image Marker - Now support both sources: imageData.features and selectedFeature from MBTiles click */}
        {selectedImageId && !poiMode && (
          <>
            {/* Try to find the feature in imageData.features */}
            {imageData.features
              .filter(
                (feature) =>
                  feature.properties.id === selectedImageId ||
                  feature.properties.id === selectedImageId
              )
              .map((feature) => {
                // For selected marker, adjust coordinates based on toggle
                const markerFeature = { ...feature };
                const [lon, lat] = getCoordinates(feature);

                markerFeature.geometry = {
                  ...markerFeature.geometry,
                  coordinates: [lon, lat],
                };

                return (
                  <SelectedMarker
                    key={feature.properties.id}
                    feature={markerFeature}
                    isCompact={isCompact}
                  />
                );
              })}

            {/* If we have a selectedFeature from MBTiles, render it */}
            {selectedFeature &&
              selectedImageId ===
                (selectedFeature.properties.id ||
                  selectedFeature.properties.id) &&
              !imageData.features.find(
                (f) =>
                  f.properties.id === selectedImageId ||
                  f.properties.id === selectedImageId
              ) && (
                <SelectedMarker
                  key={`selected-${selectedFeature.properties.id}`}
                  feature={selectedFeature}
                  isCompact={isCompact}
                />
              )}
          </>
        )}

        {/* Show POI markers when in POI mode and we have POI data */}
        {poiMode && pois && <PoiMarkers pois={pois} hoveredPoiId={hoveredPoiId} />}

        {/* Popup for searched locations */}
        {searchPinLocation && (
          <Marker
            longitude={parseFloat(searchPinLocation.longitude)}
            latitude={parseFloat(searchPinLocation.latitude)}
            anchor='bottom'
            onClick={() => setShowSearchPopup(true)}
          >
            <FaMapPin
              className={`text-3xl ${
                darkMode ? 'text-emerald-200' : 'text-emerald-600'
              } drop-shadow-lg`}
            />
          </Marker>
        )}
        {showSearchPopup && searchPinLocation && (
          <Popup
            longitude={parseFloat(searchPinLocation.longitude)}
            latitude={parseFloat(searchPinLocation.latitude)}
            closeButton={true}
            closeOnClick={false}
            onClose={() => setShowSearchPopup(false)}
            anchor='top'
            offsetTop={10}
            className='z-20'
          >
            <div className='p-2'>
              <div className='font-medium text-gray-900 mb-1'>
                {searchPinLocation.address || 'Searched Location'}
              </div>
              <div className='flex flex-col text-sm space-y-1'>
                <div className='flex items-center space-x-2'>
                  <span className='font-semibold text-emerald-600'>Lat:</span>
                  <span className='font-mono text-black bg-gray-100 px-1 rounded'>
                    {parseFloat(searchPinLocation.latitude).toFixed(6)}
                  </span>
                </div>
                <div className='flex items-center space-x-2'>
                  <span className='font-semibold text-emerald-600'>Lng:</span>
                  <span className='font-mono text-black bg-gray-100 px-1 rounded'>
                    {parseFloat(searchPinLocation.longitude).toFixed(6)}
                  </span>
                </div>
                {searchPinLocation.area && (
                  <div className='mt-1 text-gray-600'>
                    {searchPinLocation.area}, {searchPinLocation.city}
                  </div>
                )}
              </div>
            </div>
          </Popup>
        )}

        {/* Popup for right-click coordinates */}
        {showCoordsPopup && rightClickCoords && (
          <Popup
            longitude={rightClickCoords.lng}
            latitude={rightClickCoords.lat}
            closeButton={false}
            closeOnClick={false}
            onClose={() => setShowCoordsPopup(false)}
            anchor='top'
            offsetTop={10}
            maxWidth='280px'
            className='z-20 coords-popup'
          >
            <div className='w-[236px]'>
              {/* Header */}
              <div className='flex items-center gap-2.5 mb-3'>
                <div className='w-8 h-8 rounded-lg bg-teal-50 border border-teal-200/70 flex items-center justify-center text-teal-600 flex-shrink-0'>
                  <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                    <path
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      strokeWidth='2'
                      d='M12 3v3m0 12v3M3 12h3m12 0h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'
                    />
                  </svg>
                </div>
                <span className='text-sm font-bold text-slate-900 flex-1'>Coordinates</span>
                <button
                  type='button'
                  onClick={() => setShowCoordsPopup(false)}
                  className='w-6 h-6 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors'
                  aria-label='Close'
                >
                  <svg className='w-3.5 h-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                    <path strokeLinecap='round' strokeLinejoin='round' strokeWidth='2.2' d='M6 18L18 6M6 6l12 12' />
                  </svg>
                </button>
              </div>
              {/* Latitude / Longitude boxes */}
              <div className='grid grid-cols-2 gap-2 mb-3'>
                <div className='bg-slate-100/90 rounded-lg px-2.5 py-1.5 min-w-0'>
                  <div className='text-[9px] font-bold uppercase tracking-wider text-slate-400'>
                    Latitude
                  </div>
                  <div className='font-mono text-[11.5px] font-semibold text-slate-800 truncate'>
                    {rightClickCoords.lat.toFixed(8)}
                  </div>
                </div>
                <div className='bg-slate-100/90 rounded-lg px-2.5 py-1.5 min-w-0'>
                  <div className='text-[9px] font-bold uppercase tracking-wider text-slate-400'>
                    Longitude
                  </div>
                  <div className='font-mono text-[11.5px] font-semibold text-slate-800 truncate'>
                    {rightClickCoords.lng.toFixed(8)}
                  </div>
                </div>
              </div>
              {/* Copy pair */}
              <button
                type='button'
                onClick={handleCopyCoords}
                className='w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-[#0d9488] hover:bg-teal-700 text-white text-xs font-semibold shadow-sm transition-colors active:scale-[0.98]'
              >
                {copySuccess ? (
                  <>
                    <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                      <path strokeLinecap='round' strokeLinejoin='round' strokeWidth='2.5' d='M5 13l4 4L19 7' />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        strokeWidth='2'
                        d='M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z'
                      />
                    </svg>
                    Copy Pair
                  </>
                )}
              </button>
            </div>
          </Popup>
        )}

        {/* My Location marker (set from the toolbox) */}
        {userLocation && (
          <Marker
            longitude={userLocation.longitude}
            latitude={userLocation.latitude}
            anchor='center'
          >
            <div className='relative flex items-center justify-center'>
              <span className='absolute h-6 w-6 rounded-full bg-emerald-400/50 sonar-ring'></span>
              <span className='relative h-3.5 w-3.5 rounded-full bg-emerald-500 border-2 border-white shadow-md'></span>
            </div>
          </Marker>
        )}

        {/* Show delete markers when in delete mode */}
        {deleteMode && selectedPointsForDeletion.length > 0 && (
          <DeleteMarkers
            selectedPoints={selectedPointsForDeletion}
            onRemovePoint={removePointFromDeletion}
          />
        )}

        {/* POI Loading Indicator */}
        {isLoadingPois && (
          <div className='absolute inset-0 flex items-center justify-center bg-black/30 z-20'>
            <div className='glass-panel p-3 rounded-2xl shadow-floating flex items-center space-x-3'>
              <div className='animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-emerald-500'></div>
              <span className='text-sm text-slate-800 dark:text-white'>
                Loading nearby POIs...
              </span>
            </div>
          </div>
        )}
      </Map>

      {/* Left Floating Street View Guidance card (replaces the old instructions overlay) */}
      {!isCompact && (
        <div className='absolute bottom-6 left-6 z-20 max-w-sm hidden md:block'>
          <div className='glass-panel p-4 rounded-2xl shadow-floating border border-white/90 space-y-3 hover:shadow-xl transition-all duration-300 backdrop-blur-xl'>
            <div className='flex items-start space-x-3'>
              {/* Pulse green radar icon */}
              <div className='relative flex-shrink-0 mt-1'>
                <div className='w-3 h-3 rounded-full bg-emerald-500 shadow-sm'></div>
                <div className='absolute -inset-1 rounded-full bg-emerald-400/50 sonar-ring'></div>
              </div>
              <div>
                <h4 className='text-xs font-bold text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-1.5'>
                  Interactive 360° Node
                  <span className='px-2 py-0.5 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 font-bold rounded-md text-[9px] uppercase tracking-wider border border-emerald-200/60 dark:border-emerald-800'>
                    Live Data
                  </span>
                </h4>
                <p className='text-xs text-slate-600 dark:text-slate-300 mt-1 leading-relaxed'>
                  {polygonDeleteMode ? (
                    <>
                      Polygon Crop: click on the map to draw a polygon area. At
                      least <strong>3 points</strong> needed.
                    </>
                  ) : deleteMode ? (
                    <>
                      Delete Mode: click on{' '}
                      <strong className='text-rose-600'>green points</strong> to
                      select them for deletion. Use PIN 2017 to confirm.
                    </>
                  ) : poiMode ? (
                    <>
                      POI Mode: click anywhere on the map to find nearby points
                      of interest.
                    </>
                  ) : (
                    <>
                      Click on any{' '}
                      <span className='font-bold text-emerald-700 dark:text-emerald-400'>
                        green point
                      </span>{' '}
                      along the streets to instantly launch the immersive
                      360-degree panoramic street view.
                    </>
                  )}
                </p>
                {polygonDeleteMode && polygonPoints.length > 0 && (
                  <p className='text-xs mt-1 text-amber-600'>
                    {polygonPoints.length} point
                    {polygonPoints.length > 1 ? 's' : ''} drawn.{' '}
                    {polygonPoints.length >= 3
                      ? 'Ready to preview.'
                      : `Need ${3 - polygonPoints.length} more.`}
                  </p>
                )}
                {deleteMode && selectedPointsForDeletion.length > 0 && (
                  <p className='text-xs mt-1 text-rose-600'>
                    {selectedPointsForDeletion.length} point
                    {selectedPointsForDeletion.length > 1 ? 's' : ''} selected
                    for deletion.
                  </p>
                )}
                {poiMode && pois && (
                  <p className='text-xs mt-1 text-indigo-600 dark:text-indigo-400'>
                    Found {pois.length} points of interest.{' '}
                    {sidebarCollapsed ? 'Open sidebar to view list.' : ''}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating Map Toolbox (replaces NavigationControl) - hidden in compact mode */}
      {!isCompact && (
        <div className='absolute top-20 right-3 z-20 flex flex-col space-y-2 sm:right-5'>
          <div className='glass-panel rounded-2xl shadow-floating p-1.5 flex flex-col space-y-1 border border-white/90'>
            {/* Zoom In */}
            <button
              onClick={handleZoomIn}
              className='w-10 h-10 flex items-center justify-center rounded-xl text-slate-700 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-emerald-50/70 dark:hover:bg-emerald-900/30 active:scale-95 transition-all duration-200'
              title='Zoom In'
            >
              <FaPlus className='w-4 h-4' />
            </button>
            {/* Divider */}
            <div className='h-px bg-slate-200/80 dark:bg-slate-700/80 mx-2'></div>
            {/* Zoom Out */}
            <button
              onClick={handleZoomOut}
              className='w-10 h-10 flex items-center justify-center rounded-xl text-slate-700 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-emerald-50/70 dark:hover:bg-emerald-900/30 active:scale-95 transition-all duration-200'
              title='Zoom Out'
            >
              <FaMinus className='w-4 h-4' />
            </button>
          </div>
          {/* Orientation, Location & Fullscreen */}
          <div className='glass-panel rounded-2xl shadow-floating p-1.5 flex flex-col space-y-1 border border-white/90'>
            {/* Compass Reset */}
            <button
              onClick={handleResetBearing}
              className='w-10 h-10 flex items-center justify-center rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-95 transition-all duration-200 group'
              title='Reset Bearing'
            >
              <FaLocationArrow className='w-4 h-4 text-rose-500 group-hover:rotate-45 transition-transform duration-300' />
            </button>
            {/* Current Location Pinpoint */}
            <button
              onClick={handleMyLocation}
              className='w-10 h-10 flex items-center justify-center rounded-xl text-slate-700 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-emerald-50/70 dark:hover:bg-emerald-900/30 active:scale-95 transition-all duration-200'
              title='My Location'
            >
              <FaCrosshairs className='w-4 h-4' />
            </button>
            {/* Fullscreen Switch */}
            <button
              onClick={toggleFullscreen}
              className='w-10 h-10 flex items-center justify-center rounded-xl text-slate-700 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-95 transition-all duration-200'
              title='Toggle Fullscreen'
            >
              {isFullscreen ? (
                <FaCompress className='w-4 h-4' />
              ) : (
                <FaExpand className='w-4 h-4' />
              )}
            </button>
          </div>
        </div>
      )}

      {/* Bottom-Right Layer Controls card */}
      {!isCompact && (
        <div className='absolute bottom-4 left-4 right-4 z-20 w-auto sm:bottom-6 sm:left-auto sm:right-5 sm:w-72'>
          <div className='glass-panel rounded-2xl shadow-floating border border-white/90 p-4 transition-all duration-300 hover:shadow-2xl backdrop-blur-xl'>
            {/* Control Header */}
            <div className='flex items-center justify-between pb-3 border-b border-slate-200/70 dark:border-slate-700/70 mb-3'>
              <span className='text-xs font-extrabold uppercase tracking-wider text-slate-900 dark:text-white flex items-center gap-2'>
                <svg className='w-4 h-4 text-emerald-600' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                  <path
                    d='M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                  />
                </svg>
                Layer Controls
              </span>
            </div>
            {/* Toggles Stack */}
            <div className='space-y-3 text-xs'>
              {/* Toggle 1: 360° Coverage */}
              <SwitchRow
                id='toggle-visible'
                label='360° Coverage'
                checked={showPoints}
                onChange={togglePointsVisibility}
                iconBoxClass='bg-emerald-50 text-emerald-600 border-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800/60'
                labelClass={
                  showPoints
                    ? 'font-bold text-slate-800 dark:text-white'
                    : 'font-medium text-slate-700 dark:text-slate-300'
                }
                accentClass='peer-checked:bg-emerald-500'
              >
                <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                  <path
                    d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                  />
                  <path
                    d='M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                  />
                </svg>
              </SwitchRow>

              {/* Toggle 1b: Trajectory Lines (dots -> lines) */}
              <SwitchRow
                id='toggle-lines'
                label='Lines'
                checked={showLines}
                onChange={() => setShowLines((prev) => !prev)}
                iconBoxClass='bg-teal-50 text-teal-600 border-teal-100 dark:bg-teal-900/30 dark:text-teal-400 dark:border-teal-800/60'
                labelClass={
                  showLines
                    ? 'font-bold text-slate-800 dark:text-white'
                    : 'font-medium text-slate-700 dark:text-slate-300'
                }
                accentClass='peer-checked:bg-teal-500'
              >
                {linesLoading ? (
                  <svg
                    className='w-4 h-4 animate-spin'
                    fill='none'
                    viewBox='0 0 24 24'
                  >
                    <circle
                      className='opacity-25'
                      cx='12'
                      cy='12'
                      r='10'
                      stroke='currentColor'
                      strokeWidth='4'
                    />
                    <path
                      className='opacity-75'
                      fill='currentColor'
                      d='M4 12a8 8 0 018-8v8H4z'
                    />
                  </svg>
                ) : (
                  <FaRoute className='w-4 h-4' />
                )}
              </SwitchRow>

              {/* Toggle 2: Delete Mode (admin only) */}
              {isAdmin && (
              <SwitchRow
                id='toggle-delete'
                label='Delete Mode'
                checked={deleteMode}
                onChange={toggleDeleteMode}
                iconBoxClass={
                  deleteMode
                    ? 'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-800'
                    : 'bg-slate-100 text-slate-600 border-slate-200/60 group-hover:bg-rose-50 group-hover:text-rose-600 transition-colors dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                }
                labelClass={
                  deleteMode
                    ? 'font-bold text-slate-800 dark:text-white'
                    : 'font-medium text-slate-700 dark:text-slate-300'
                }
                accentClass='peer-checked:bg-rose-500'
              >
                <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                  <path
                    d='M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                  />
                </svg>
              </SwitchRow>
              )}

              {/* Toggle 3: Polygon Crop (admin only) */}
              {isAdmin && (
              <SwitchRow
                id='toggle-polygon'
                label='Polygon Crop'
                checked={polygonDeleteMode}
                onChange={togglePolygonDeleteMode}
                iconBoxClass={
                  polygonDeleteMode
                    ? 'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800'
                    : 'bg-slate-100 text-slate-600 border-slate-200/60 group-hover:bg-amber-50 group-hover:text-amber-600 transition-colors dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                }
                labelClass={
                  polygonDeleteMode
                    ? 'font-bold text-slate-800 dark:text-white'
                    : 'font-medium text-slate-700 dark:text-slate-300'
                }
                accentClass='peer-checked:bg-amber-500'
              >
                <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                  <path
                    d='M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                  />
                </svg>
              </SwitchRow>
              )}

              {/* Toggle 4: POI Markers */}
              <SwitchRow
                id='toggle-poi'
                label='POI Markers'
                checked={poiMode}
                onChange={togglePoiMode}
                iconBoxClass={
                  poiMode
                    ? 'bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800'
                    : 'bg-slate-100 text-slate-600 border-slate-200/60 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-colors dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                }
                labelClass={
                  poiMode
                    ? 'font-bold text-slate-800 dark:text-white'
                    : 'font-medium text-slate-700 dark:text-slate-300'
                }
                accentClass='peer-checked:bg-indigo-500'
              >
                <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                  <path
                    d='M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                  />
                  <path
                    d='M15 11a3 3 0 11-6 0 3 3 0 016 0z'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                  />
                </svg>
              </SwitchRow>
            </div>
            {/* Attribution Footer inside panel */}
            <div className='mt-3 pt-2.5 border-t border-slate-200/70 dark:border-slate-700/70 flex items-center justify-end text-[10px] text-slate-500 dark:text-slate-400 font-medium'>
              <span className='font-semibold text-slate-600 dark:text-slate-300'>
                ThirdEye360 © Barikoi
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Delete mode controls */}
      {!isCompact && deleteMode && (
        <div className='absolute top-4 left-4 right-4 z-20 glass-panel rounded-2xl shadow-floating p-4 max-w-sm border border-white/90 sm:left-6 sm:right-auto'>
          <div className='flex items-center space-x-2 mb-3'>
            <FaTrashAlt className='text-rose-500' />
            <h3 className='font-semibold text-slate-800 dark:text-slate-200'>
              Delete Mode Active
            </h3>
          </div>
          <p className='text-sm text-slate-600 dark:text-slate-400 mb-3'>
            Click on green points to select them for deletion. Selected:{' '}
            {selectedPointsForDeletion.length}
          </p>
          <div className='flex space-x-2'>
            <button
              onClick={() => setShowDeleteModal(true)}
              disabled={selectedPointsForDeletion.length === 0}
              className='px-3 py-2 bg-rose-600 text-white rounded-xl hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center text-sm shadow-md shadow-rose-600/20'
            >
              <FaTrashAlt className='mr-1' />
              Delete ({selectedPointsForDeletion.length})
            </button>
            <button
              onClick={() => setSelectedPointsForDeletion([])}
              disabled={selectedPointsForDeletion.length === 0}
              className='px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm'
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Delete Points Modal */}
      <DeletePointsModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        selectedPoints={selectedPointsForDeletion}
        onDeleteConfirm={handleDeleteConfirm}
        isDeleting={isDeletingPoints}
      />

      {/* Polygon Delete Panel */}
      {!isCompact && (
        <PolygonDeletePanel
          isOpen={showPolygonPanel}
          onClose={closePolygonPanel}
          polygonPoints={polygonPoints}
          onClearPolygon={clearPolygon}
          onUndoLastPoint={undoLastPolygonPoint}
          map={mapInstance}
        />
      )}
    </div>
  );
};

export default React.memo(MapComponent, (prevProps, nextProps) => {
  return (
    prevProps.selectedImageId === nextProps.selectedImageId &&
    prevProps.selectedImage === nextProps.selectedImage &&
    prevProps.isLoading === nextProps.isLoading &&
    prevProps.isCompact === nextProps.isCompact
  );
});
