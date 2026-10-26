'use client';

import { useRef } from 'react';
import Upload360Panel from './Upload360Panel';

/**
 * Modal overlay wrapper around Upload360Panel. The primary entry point is
 * now the dedicated /upload route (opened in a new tab from the header);
 * this wrapper is kept for in-app usage.
 */
export default function Upload360Modal({ isOpen, onClose }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  if (!isOpen) return null;

  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/60 backdrop-blur-md fade-in'
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current?.();
      }}
    >
      <div className='w-full max-w-2xl max-h-[90vh] flex flex-col overflow-y-auto'>
        <Upload360Panel onClose={onClose} />
      </div>
    </div>
  );
}
