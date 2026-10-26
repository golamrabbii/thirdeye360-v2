"use client";

import React, { useState } from 'react';
import { MdChevronLeft, MdChevronRight, MdLocationOn } from 'react-icons/md';

const PoiSidebar = ({
  pois,
  onHover,
  activePoiId,
  collapsed,
  setCollapsed,
}) => {
  // Function to truncate text if it's too long
  const truncateText = (text, maxLength = 25) => {
    if (!text) return '';
    return text.length > maxLength
      ? text.substring(0, maxLength) + '...'
      : text;
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

  // Group POIs by type for better organization
  const groupedPois =
    pois?.reduce((acc, poi) => {
      if (!acc[poi.type]) {
        acc[poi.type] = [];
      }
      acc[poi.type].push(poi);
      return acc;
    }, {}) || {};

  return (
    <div
      className={`fixed left-0 top-[104px] bottom-0 z-10 flex transition-all duration-300 ease-in-out transform ${
        collapsed ? '-translate-x-full' : 'translate-x-0'
      }`}
      style={{ maxWidth: '400px' }}
    >
      {/* Main Panel */}
      <div className='glass-panel shadow-floating h-full overflow-hidden flex flex-col border-r border-slate-200/70 dark:border-slate-700/70'>
        <div className='bg-white/60 dark:bg-slate-800/60 p-3 flex items-center justify-between border-b border-slate-200/70 dark:border-slate-700/70'>
          <h2 className='text-base font-bold text-slate-900 dark:text-white'>
            Points of Interest
          </h2>
          <div className='flex items-center space-x-2'>
            <span className='text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200/60'>
              {pois?.length || 0} found
            </span>
          </div>
        </div>

        {/* POI List */}
        <div className='flex-grow overflow-y-auto p-2'>
          {pois?.length ? (
            Object.entries(groupedPois).map(([type, typePois]) => (
              <div key={type} className='mb-4'>
                <h3 className='text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-2 bg-white/60 dark:bg-slate-800/60 p-2 rounded-lg border border-slate-200/60 dark:border-slate-700/60'>
                  {type} ({typePois.length})
                </h3>
                <div className='space-y-2'>
                  {typePois.map((poi) => (
                    <div
                      key={poi.id}
                      className={`p-3 rounded-xl cursor-pointer transition-all border ${
                        activePoiId === poi.id
                          ? 'bg-emerald-50 dark:bg-emerald-900/30 border-l-4 border-emerald-500'
                          : 'bg-white/80 dark:bg-slate-900/80 hover:bg-white dark:hover:bg-slate-800 border-l-4 border-transparent'
                      }`}
                      onMouseEnter={() => onHover(poi.id)}
                      onMouseLeave={() => onHover(null)}
                    >
                      <div className='flex items-start'>
                        <MdLocationOn
                          size={24}
                          className='mt-1 mr-2 flex-shrink-0'
                          color={getPoiColor(poi.type)}
                        />
                        <div>
                          <h4 className='font-medium text-slate-800 dark:text-slate-200'>
                            {poi.text}
                          </h4>
                          <div className='text-xs text-slate-500 dark:text-slate-400 mt-1'>
                            {poi.language !== 'English' && (
                              <span className='inline-block bg-slate-100 dark:bg-slate-700 rounded px-1 mr-1'>
                                {poi.language}
                              </span>
                            )}
                            <span className='text-slate-500 dark:text-slate-400'>
                              {truncateText(poi.location, 40)}
                            </span>
                          </div>
                          <div className='mt-1 flex items-center'>
                            <div
                              className='w-1 h-6 rounded-full mr-2'
                              style={{ backgroundColor: getPoiColor(poi.type) }}
                            ></div>
                            <span className='text-xs font-medium text-slate-600 dark:text-slate-300'>
                              Confidence: {Math.round(poi.confidence * 100)}%
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className='flex flex-col items-center justify-center h-full text-slate-500 dark:text-slate-400'>
              <MdLocationOn
                size={48}
                className='text-slate-300 dark:text-slate-600 mb-2'
              />
              <p>No POIs found in this area</p>
              <p className='text-sm'>
                Click on the map to find Points of Interest
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Toggle button */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className='h-12 w-6 bg-slate-200/90 dark:bg-slate-700/90 self-center flex items-center justify-center rounded-r shadow-md'
        aria-label={collapsed ? 'Expand POI panel' : 'Collapse POI panel'}
      >
        {collapsed ? <MdChevronRight /> : <MdChevronLeft />}
      </button>
    </div>
  );
};

export default PoiSidebar;
