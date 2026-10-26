"use client";

import React from 'react';
import { Marker } from 'react-map-gl/maplibre';
import { MdDelete } from 'react-icons/md';

const DeleteMarkers = ({ selectedPoints, onRemovePoint }) => {
  return (
    <>
      {selectedPoints.map((point) => (
        <Marker
          key={`delete-${point.id}`}
          longitude={point.longitude}
          latitude={point.latitude}
          anchor='center'
        >
          <div className='relative group'>
            {/* Selection indicator circle */}
            <div className='w-8 h-8 bg-rose-500 border-4 border-white dark:border-slate-800 rounded-full shadow-lg animate-pulse flex items-center justify-center'>
              <MdDelete className='text-white text-sm' />
            </div>

            {/* Remove button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemovePoint(point.id);
              }}
              className='absolute -top-2 -right-2 w-5 h-5 bg-slate-800 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center text-xs hover:bg-slate-700'
              title='Remove from selection'
            >
              ×
            </button>

            {/* Point ID tooltip */}
            <div className='absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 whitespace-nowrap'>
              ID: {point.id}
            </div>
          </div>
        </Marker>
      ))}
    </>
  );
};

export default DeleteMarkers;
