"use client";

import React, { useState, useEffect, useCallback } from 'react';
import {
  MdClose,
  MdDelete,
  MdWarning,
  MdCheck,
  MdRefresh,
  MdUndo,
} from 'react-icons/md';
import {
  FaDrawPolygon,
  FaTrashAlt,
  FaLock,
  FaSpinner,
  FaMapMarkerAlt,
} from 'react-icons/fa';

// Use environment variable for API base URL
import { API_BASE_URL } from '../../config/api';

const PolygonDeletePanel = ({
  isOpen,
  onClose,
  polygonPoints,
  onClearPolygon,
  onUndoLastPoint,
  map,
}) => {
  const [step, setStep] = useState('draw'); // "draw", "preview", "pin", "confirm", "success"
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [verificationData, setVerificationData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteStats, setDeleteStats] = useState(null);

  const canPreview = polygonPoints && polygonPoints.length >= 3;

  // Reset state when panel opens/closes
  useEffect(() => {
    if (isOpen) {
      setStep('draw');
      setPin('');
      setPinError('');
      setVerificationData(null);
      setDeleteStats(null);
    }
  }, [isOpen]);

  // Verify deletion - call API to preview what will be deleted
  const handleVerifyDeletion = useCallback(async () => {
    if (!canPreview) return;

    setIsLoading(true);
    setStep('preview');

    try {
      // Create polygon geojson - ensure proper closure
      const coordinates = [...polygonPoints];
      // Close the polygon by adding first point at the end
      coordinates.push(coordinates[0]);

      const geojson = {
        type: 'Polygon',
        coordinates: [coordinates],
      };

      const response = await fetch(`${API_BASE_URL}/features/verify-deletion`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ geojson }),
      });

      if (!response.ok) {
        throw new Error(`Verification failed: ${response.status}`);
      }

      const result = await response.json();
      setVerificationData(result);
    } catch (error) {
      console.error('Error verifying deletion:', error);
      setPinError(`Failed to verify: ${error.message}`);
      setStep('draw');
    } finally {
      setIsLoading(false);
    }
  }, [polygonPoints, canPreview]);

  // Handle PIN submission
  const handlePinSubmit = () => {
    if (pin !== '2017') {
      setPinError('Incorrect PIN. Access denied.');
      setPin('');
      return;
    }
    setPinError('');
    setStep('confirm');
  };

  // Handle confirmed deletion
  const handleConfirmDelete = async () => {
    if (!verificationData) return;

    setIsDeleting(true);

    try {
      // Create polygon geojson for deletion
      const coordinates = [...polygonPoints];
      coordinates.push(coordinates[0]);

      const geojson = {
        type: 'Polygon',
        coordinates: [coordinates],
      };

      const response = await fetch(`${API_BASE_URL}/features/delete-batch`, {
        method: 'DELETE',
        headers: {
          accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ geojson }),
      });

      if (!response.ok) {
        throw new Error(`Delete failed: ${response.status}`);
      }

      const result = await response.json();
      setDeleteStats(result);
      setStep('success');

      // Auto close after success
      setTimeout(() => {
        onClearPolygon();
        onClose();
      }, 2500);
    } catch (error) {
      console.error('Error deleting features:', error);
      setPinError(`Delete failed: ${error.message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  // Handle key press for PIN input
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && step === 'pin') {
      handlePinSubmit();
    }
  };

  // Go back to drawing
  const handleBackToDraw = () => {
    setStep('draw');
    setVerificationData(null);
    setPin('');
    setPinError('');
  };

  if (!isOpen) return null;

  return (
    <div className='absolute top-4 left-6 z-20 glass-panel rounded-2xl shadow-floating w-80 max-h-[calc(100vh-120px)] overflow-hidden border border-white/90'>
      {/* Header */}
      <div className='bg-gradient-to-r from-amber-500 to-rose-600 text-white p-4'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center space-x-3'>
            <FaDrawPolygon className='text-xl' />
            <div>
              <h3 className='font-bold text-lg'>Polygon Delete</h3>
              <p className='text-amber-50 text-xs'>
                Draw area to batch delete points
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className='p-1.5 rounded-full hover:bg-white/20 transition-colors'
            aria-label='Close'
          >
            <MdClose size={20} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className='p-4 overflow-y-auto max-h-[calc(100vh-220px)] text-slate-800 dark:text-slate-200'>
        {/* Step: Draw */}
        {step === 'draw' && (
          <div className='space-y-4'>
            <div className='bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-3 border border-emerald-200/70 dark:border-emerald-800'>
              <p className='text-sm text-emerald-800 dark:text-emerald-200'>
                <strong>How to use:</strong>
              </p>
              <ol className='text-xs text-emerald-700 dark:text-emerald-300 mt-2 space-y-1 list-decimal list-inside'>
                <li>Click on the map to add polygon points</li>
                <li>Add at least 3 points to form a polygon</li>
                <li>Click Preview to see affected points</li>
              </ol>
            </div>

            <div className='flex items-center justify-between text-sm'>
              <span className='text-slate-600 dark:text-slate-400'>
                Points drawn:
              </span>
              <span
                className={`font-bold ${
                  canPreview
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`}
              >
                {polygonPoints?.length || 0} / 3 min
              </span>
            </div>

            {/* Point list preview */}
            {polygonPoints && polygonPoints.length > 0 && (
              <div className='bg-slate-50 dark:bg-slate-800/60 rounded-xl p-2 max-h-24 overflow-y-auto'>
                {polygonPoints.map((point, idx) => (
                  <div
                    key={idx}
                    className='flex items-center text-xs text-slate-600 dark:text-slate-400 py-0.5'
                  >
                    <FaMapMarkerAlt className='mr-1.5 text-amber-500' />
                    <span className='font-mono'>
                      [{point[0].toFixed(5)}, {point[1].toFixed(5)}]
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Action buttons */}
            <div className='flex space-x-2'>
              <button
                onClick={onUndoLastPoint}
                disabled={!polygonPoints || polygonPoints.length === 0}
                className='flex-1 px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center text-sm'
              >
                <MdUndo className='mr-1.5' />
                Undo
              </button>
              <button
                onClick={onClearPolygon}
                disabled={!polygonPoints || polygonPoints.length === 0}
                className='flex-1 px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center text-sm'
              >
                <MdRefresh className='mr-1.5' />
                Clear
              </button>
            </div>

            <button
              onClick={handleVerifyDeletion}
              disabled={!canPreview || isLoading}
              className='w-full px-4 py-3 bg-gradient-to-r from-amber-500 to-rose-600 text-white rounded-xl hover:from-amber-600 hover:to-rose-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center font-medium shadow-md shadow-rose-600/20'
            >
              {isLoading ? (
                <>
                  <FaSpinner className='animate-spin mr-2' />
                  Verifying...
                </>
              ) : (
                <>
                  <FaTrashAlt className='mr-2' />
                  Preview Deletion
                </>
              )}
            </button>
          </div>
        )}

        {/* Step: Preview */}
        {step === 'preview' && isLoading && (
          <div className='flex flex-col items-center justify-center py-8'>
            <FaSpinner className='animate-spin text-4xl text-amber-500 mb-4' />
            <p className='text-slate-600 dark:text-slate-400'>
              Checking features in polygon...
            </p>
          </div>
        )}

        {step === 'preview' && !isLoading && verificationData && (
          <div className='space-y-4'>
            {/* Stats */}
            <div className='grid grid-cols-2 gap-2'>
              <div className='bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 text-center'>
                <p className='text-2xl font-bold text-slate-800 dark:text-slate-200'>
                  {verificationData.total_in_polygon || 0}
                </p>
                <p className='text-xs text-slate-500 dark:text-slate-400'>
                  Total in Area
                </p>
              </div>
              <div className='bg-rose-50 dark:bg-rose-900/20 rounded-xl p-3 text-center border border-rose-200 dark:border-rose-800'>
                <p className='text-2xl font-bold text-rose-600 dark:text-rose-400'>
                  {verificationData.active_features || 0}
                </p>
                <p className='text-xs text-rose-600 dark:text-rose-400'>
                  To Delete
                </p>
              </div>
            </div>

            {verificationData.already_deleted > 0 && (
              <div className='bg-amber-50 dark:bg-amber-900/20 rounded-xl p-2 text-center border border-amber-200 dark:border-amber-800'>
                <p className='text-sm text-amber-700 dark:text-amber-300'>
                  {verificationData.already_deleted} already deleted
                </p>
              </div>
            )}

            {/* Feature list preview */}
            {verificationData.features &&
              verificationData.features.length > 0 && (
                <div className='border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden'>
                  <div className='bg-slate-100 dark:bg-slate-800 px-3 py-2 border-b border-slate-200 dark:border-slate-700'>
                    <p className='text-xs font-medium text-slate-600 dark:text-slate-300'>
                      Features to delete (showing first 20)
                    </p>
                  </div>
                  <div className='max-h-40 overflow-y-auto'>
                    {verificationData.features.slice(0, 20).map((feature) => (
                      <div
                        key={feature.feature_id}
                        className='flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-800 last:border-b-0 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                      >
                        <div>
                          <p className='text-sm font-medium text-slate-800 dark:text-slate-200'>
                            {feature.feature_id}
                          </p>
                          <p className='text-xs text-slate-500 dark:text-slate-400 font-mono'>
                            [{feature.coordinates?.[0]?.toFixed(5)},{' '}
                            {feature.coordinates?.[1]?.toFixed(5)}]
                          </p>
                        </div>
                        <MdDelete className='text-rose-500' />
                      </div>
                    ))}
                  </div>
                </div>
              )}

            {/* Action buttons */}
            <div className='flex space-x-2'>
              <button
                onClick={handleBackToDraw}
                className='flex-1 px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors text-sm'
              >
                Redraw Area
              </button>
              <button
                onClick={() => setStep('pin')}
                disabled={
                  !verificationData.active_features ||
                  verificationData.active_features === 0
                }
                className='flex-1 px-3 py-2 bg-rose-600 text-white rounded-xl hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center text-sm font-medium'
              >
                <FaTrashAlt className='mr-1.5' />
                Proceed
              </button>
            </div>
          </div>
        )}

        {/* Step: PIN */}
        {step === 'pin' && (
          <div className='space-y-4'>
            <div className='text-center'>
              <FaLock className='mx-auto text-4xl text-slate-400 mb-3' />
              <h4 className='font-semibold text-slate-800 dark:text-slate-200 mb-1'>
                Security Verification
              </h4>
              <p className='text-sm text-slate-600 dark:text-slate-400'>
                Enter PIN to delete {verificationData?.active_features || 0}{' '}
                features
              </p>
            </div>

            <input
              type='password'
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder='Enter PIN'
              className='w-full px-4 py-3 text-center text-xl tracking-widest border border-slate-300 dark:border-slate-600 rounded-xl focus:ring-2 focus:ring-rose-500 focus:border-rose-500 dark:bg-slate-800 dark:text-white'
              maxLength='4'
              autoFocus
            />

            {pinError && (
              <div className='flex items-center text-rose-600 text-sm bg-rose-50 dark:bg-rose-900/20 px-3 py-2 rounded-xl'>
                <MdWarning className='mr-2' />
                {pinError}
              </div>
            )}

            <div className='flex space-x-2'>
              <button
                onClick={() => setStep('preview')}
                className='flex-1 px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors text-sm'
              >
                Back
              </button>
              <button
                onClick={handlePinSubmit}
                disabled={pin.length < 4}
                className='flex-1 px-3 py-2 bg-rose-600 text-white rounded-xl hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium'
              >
                Verify
              </button>
            </div>
          </div>
        )}

        {/* Step: Confirm */}
        {step === 'confirm' && (
          <div className='space-y-4'>
            <div className='text-center'>
              <div className='mx-auto w-16 h-16 bg-rose-100 dark:bg-rose-900/30 rounded-full flex items-center justify-center mb-3'>
                <MdWarning className='text-3xl text-rose-600' />
              </div>
              <h4 className='font-semibold text-slate-800 dark:text-slate-200 mb-1'>
                Final Confirmation
              </h4>
              <p className='text-sm text-slate-600 dark:text-slate-400'>
                This will permanently delete{' '}
                <strong>{verificationData?.active_features || 0}</strong>{' '}
                features. This cannot be undone.
              </p>
            </div>

            <div className='flex space-x-2'>
              <button
                onClick={() => setStep('pin')}
                className='flex-1 px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors text-sm'
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className='flex-1 px-3 py-2 bg-rose-600 text-white rounded-xl hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center text-sm font-medium'
              >
                {isDeleting ? (
                  <>
                    <FaSpinner className='animate-spin mr-2' />
                    Deleting...
                  </>
                ) : (
                  <>
                    <MdDelete className='mr-1.5' />
                    Confirm Delete
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Step: Success */}
        {step === 'success' && (
          <div className='text-center py-6 space-y-4'>
            <div className='mx-auto w-20 h-20 bg-emerald-100 dark:bg-emerald-900/30 rounded-full flex items-center justify-center'>
              <MdCheck className='text-5xl text-emerald-600' />
            </div>
            <div>
              <h4 className='text-lg font-semibold text-slate-800 dark:text-slate-200'>
                Deletion Complete
              </h4>
              <p className='text-sm text-slate-600 dark:text-slate-400 mt-1'>
                {deleteStats?.deleted_count || verificationData?.active_features || 0}{' '}
                features have been deleted successfully.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PolygonDeletePanel;
