"use client";

import React from 'react';
import {
  MdClose,
  MdLocationOn,
  MdLanguage,
  MdCheck,
  MdWarning,
} from 'react-icons/md';

const PoiModal = ({ poi, isOpen, onClose }) => {
  if (!isOpen || !poi) return null;

  const getConfidenceColor = (confidence) => {
    if (confidence >= 0.9) return 'text-emerald-500';
    if (confidence >= 0.7) return 'text-amber-500';
    return 'text-rose-500';
  };

  const getConfidenceIcon = (confidence) => {
    if (confidence >= 0.9) return <MdCheck className='text-emerald-500' />;
    if (confidence >= 0.7) return <MdWarning className='text-amber-500' />;
    return <MdWarning className='text-rose-500' />;
  };

  return (
    <div className='fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50'>
      <div className='bg-white dark:bg-slate-900 rounded-2xl w-full max-w-md mx-4 overflow-hidden shadow-2xl transform transition-all scale-in'>
        {/* Header with image */}
        <div className='relative'>
          {poi.image_url && (
            <img
              src={poi.image_url}
              alt={poi.text}
              className='w-full h-48 object-cover'
            />
          )}
          <button
            onClick={onClose}
            className='absolute top-2 right-2 p-1 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors'
            aria-label='Close'
          >
            <MdClose size={24} />
          </button>
        </div>

        {/* Content */}
        <div className='p-4'>
          <h2 className='text-xl font-bold mb-2 text-slate-900 dark:text-white'>
            {poi.text}
          </h2>

          <div className='grid grid-cols-2 gap-2 mb-4'>
            <div className='flex items-center space-x-2'>
              <MdLocationOn className='text-emerald-600' />
              <span className='text-slate-700 dark:text-slate-300'>
                {poi.type}
              </span>
            </div>
            <div className='flex items-center space-x-2'>
              <MdLanguage className='text-emerald-600' />
              <span className='text-slate-700 dark:text-slate-300'>
                {poi.language}
              </span>
            </div>
          </div>

          <div className='bg-slate-50 dark:bg-slate-800 p-3 rounded-xl mb-4'>
            <h3 className='font-semibold mb-1 text-slate-900 dark:text-white'>
              Location Details
            </h3>
            <p className='text-sm text-slate-700 dark:text-slate-300'>
              {poi.location}
            </p>
            <div className='mt-2 grid grid-cols-2 gap-2 text-sm'>
              <div>
                <span className='text-slate-500 dark:text-slate-400'>
                  Latitude:{' '}
                </span>
                <span className='font-mono'>{poi.latitude.toFixed(6)}</span>
              </div>
              <div>
                <span className='text-slate-500 dark:text-slate-400'>
                  Longitude:{' '}
                </span>
                <span className='font-mono'>{poi.longitude.toFixed(6)}</span>
              </div>
            </div>
          </div>

          <div className='flex items-center justify-between'>
            <div className='flex items-center space-x-2'>
              <span className='text-slate-600 dark:text-slate-400'>
                Confidence:
              </span>
              <div className='flex items-center'>
                {getConfidenceIcon(poi.confidence)}
                <span className={`ml-1 ${getConfidenceColor(poi.confidence)}`}>
                  {Math.round(poi.confidence * 100)}%
                </span>
              </div>
            </div>
            <div className='text-sm text-slate-500'>ID: {poi.id}</div>
          </div>

          {poi.distance_meters > 0 && (
            <div className='mt-2 text-sm text-slate-600 dark:text-slate-400'>
              Distance: {poi.distance_meters} meters
            </div>
          )}
        </div>

        {/* Footer */}
        <div className='bg-slate-50 dark:bg-slate-800 px-4 py-3 sm:flex sm:flex-row-reverse'>
          <button
            type='button'
            className='w-full inline-flex justify-center rounded-xl shadow-sm px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 text-base font-medium text-white hover:from-emerald-700 hover:to-teal-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 sm:ml-3 sm:w-auto sm:text-sm'
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default PoiModal;
