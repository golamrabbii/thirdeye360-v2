"use client";

import React, { useState, useEffect, useRef } from 'react';

// Use environment variable or default to a placeholder that will be replaced
const API_KEY = process.env.NEXT_PUBLIC_BARIKOI_API_KEY || 'api_key';

const MapSearchBar = ({ onLocationSelect, className }) => {
  const [searchValue, setSearchValue] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchRef = useRef(null);
  const inputRef = useRef(null);

  // Regular expression for matching latitude,longitude format
  const coordRegex = /^(-?\d+(\.\d+)?),\s*(-?\d+(\.\d+)?)$/;

  // Handle clicks outside of the component to close the dropdown
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (searchRef.current && !searchRef.current.contains(event.target)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [searchRef]);

  // Cmd/Ctrl + K shortcut to focus the search field
  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        setShowSuggestions(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Search for places using Barikoi API
  const searchPlaces = async (value) => {
    if (!value || value.length < 2) {
      setSuggestions([]);
      return;
    }

    // Check if input is direct coordinates (latitude,longitude)
    const coordMatch = value.match(coordRegex);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[3]);
      setSuggestions([
        {
          id: 'coordinates',
          value: `${lat},${lng}`,
          longitude: lng,
          latitude: lat,
          address: `Coordinates: ${lat}, ${lng}`,
          isCoordinate: true,
        },
      ]);
      return;
    }

    // Otherwise search using Barikoi API
    setLoading(true);
    try {
      const response = await fetch(
        `https://barikoi.xyz/v2/api/search/autocomplete/place?api_key=NDE2NzpVNzkyTE5UMUoy&q=${encodeURIComponent(
          value
        )}&sub_area=true&sub_district=true`
      );
      const data = await response.json();

      if (data.status === 200 && data.places && data.places.length > 0) {
        const searchResults = data.places.map((place) => ({
          id: place.id,
          value: place.address,
          longitude: place.longitude,
          latitude: place.latitude,
          address: place.address,
          area: place.area,
          city: place.city,
        }));
        setSuggestions(searchResults);
      } else {
        setSuggestions([
          { id: 'no-results', value: 'No results found', disabled: true },
        ]);
      }
    } catch (error) {
      console.error('Error searching places:', error);
      setSuggestions([
        { id: 'error', value: 'Error searching places', disabled: true },
      ]);
    } finally {
      setLoading(false);
    }
  };

  // Handle input change
  const handleInputChange = (e) => {
    const value = e.target.value;
    setSearchValue(value);
    searchPlaces(value);
    setShowSuggestions(true);
  };

  // Handle selection of a place or coordinate
  const handleSelect = (suggestion) => {
    if (suggestion && !suggestion.disabled) {
      // Format coordinates to 6 decimal places for precision
      const formattedLocation = {
        longitude: parseFloat(suggestion.longitude).toFixed(6),
        latitude: parseFloat(suggestion.latitude).toFixed(6),
        address: suggestion.address,
        area: suggestion.area,
        city: suggestion.city,
        // Add showPin flag to indicate this location should be pinned on the map
        showPin: true,
      };

      onLocationSelect(formattedLocation);

      // Keep the selected value in the input
      setSearchValue(suggestion.address || suggestion.value);
      setShowSuggestions(false);
    }
  };

  // Submit action: pick the first live suggestion (or coordinate match)
  const handleSubmit = () => {
    const coordMatch = searchValue.match(coordRegex);
    if (coordMatch && suggestions.length > 0 && suggestions[0].isCoordinate) {
      handleSelect(suggestions[0]);
      return;
    }

    const firstValid = suggestions.find(
      (suggestion) => !suggestion.disabled && suggestion.longitude !== undefined
    );

    if (firstValid) {
      handleSelect(firstValid);
    } else {
      inputRef.current?.focus();
    }
  };

  return (
    <div ref={searchRef} className={`relative w-full ${className || ''}`}>
      {/* Search Input Shell - floating glass panel */}
      <div className='relative glass-panel rounded-2xl shadow-floating p-1.5 flex items-center border border-white/90 dark:border-slate-700/80 transition-all duration-300 hover:shadow-2xl hover:border-emerald-500/30'>
        <div className='pl-3.5 text-slate-400 flex items-center justify-center pointer-events-none'>
          <svg className='w-5 h-5 text-slate-500' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
            <path
              d='M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z'
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth='2.2'
            />
          </svg>
        </div>
        <input
          ref={inputRef}
          type='text'
          className='w-full bg-transparent border-none text-xs md:text-sm text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-0 px-3 py-2 font-medium tracking-tight'
          placeholder='Search for a place or enter coordinates (lat, lng)... e.g. 23.8103, 90.4125'
          value={searchValue}
          onChange={handleInputChange}
          onFocus={() => setShowSuggestions(true)}
          onKeyPress={(e) => {
            if (e.key === 'Enter') handleSubmit();
          }}
        />
        {/* Shortcut and clear actions */}
        <div className='flex items-center space-x-2 pr-1.5'>
          {loading && (
            <span className='hidden sm:inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-bold font-mono bg-slate-100 dark:bg-slate-800 text-emerald-600 border border-slate-200/80 dark:border-slate-700 shadow-sm'>
              ...
            </span>
          )}
          <button
            onClick={handleSubmit}
            className='w-9 h-9 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-xs font-semibold transition-all flex items-center justify-center shadow-md shadow-emerald-600/25 active:scale-95'
            aria-label='Search'
          >
            <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path
                d='M14 5l7 7m0 0l-7 7m7-7H3'
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth='2.2'
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Dropdown with suggestions */}
      {showSuggestions && suggestions.length > 0 && (
        <div className='absolute z-30 w-full mt-2 glass-panel rounded-2xl shadow-floating border border-white/90 overflow-hidden'>
          <ul className='max-h-60 overflow-y-auto py-2'>
            {suggestions.map((suggestion) => (
              <li
                key={suggestion.id}
                className={`px-4 py-3 cursor-pointer hover:bg-emerald-50/70 dark:hover:bg-emerald-900/20
                          transition-colors duration-150 ease-in-out
                          ${
                            suggestion.disabled
                              ? 'opacity-60 cursor-not-allowed'
                              : ''
                          }`}
                onClick={() => !suggestion.disabled && handleSelect(suggestion)}
              >
                {suggestion.isCoordinate ? (
                  <div className='flex items-center'>
                    <span className='inline-flex items-center justify-center w-8 h-8 me-2 rounded-full bg-emerald-100 dark:bg-emerald-900'>
                      <svg
                        className='w-4 h-4 text-emerald-600 dark:text-emerald-300'
                        aria-hidden='true'
                        xmlns='http://www.w3.org/2000/svg'
                        fill='currentColor'
                        viewBox='0 0 16 20'
                      >
                        <path d='M8 0a8 8 0 0 0-8 8c0 1.8.6 3.5 1.7 5 1.5 2 6.3 7 6.3 7s4.8-5 6.3-7a7.9 7.9 0 0 0 1.7-5 8 8 0 0 0-8-8zm0 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z' />
                      </svg>
                    </span>
                    <span className='font-medium text-slate-800 dark:text-slate-200'>
                      Go to coordinates: {suggestion.latitude},{' '}
                      {suggestion.longitude}
                    </span>
                  </div>
                ) : suggestion.disabled ? (
                  <div className='text-slate-500 dark:text-slate-400'>
                    {suggestion.value}
                  </div>
                ) : (
                  <div>
                    <div className='font-medium text-slate-800 dark:text-slate-200'>
                      {suggestion.address}
                    </div>
                    {suggestion.area && (
                      <div className='text-sm text-slate-500 dark:text-slate-400'>
                        {suggestion.area}
                        {suggestion.city ? `, ${suggestion.city}` : ''}
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default MapSearchBar;
