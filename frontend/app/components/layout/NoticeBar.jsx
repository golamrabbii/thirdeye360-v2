'use client';

import { useState, useEffect } from 'react';

const HINT_KEY = 'thirdeye_hint_dismissed';

/**
 * Dismissible floating hint chip (bottom-center of the map).
 * Replaces the old always-on Quick Guide bar — the map keeps its pixels and
 * the tip goes away for good once dismissed (persisted in localStorage).
 */
export default function NoticeBar() {
  const [dismissed, setDismissed] = useState(true); // true pre-hydration: no flash

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(HINT_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // private mode etc. — session-only dismissal is fine
    }
  };

  if (dismissed) return null;

  return (
    <div className='pointer-events-none absolute bottom-6 left-1/2 z-20 hidden w-[min(92vw,34rem)] -translate-x-1/2 md:block'>
      <div className='glass-panel pointer-events-auto flex items-center gap-2.5 rounded-2xl px-4 py-2.5 shadow-floating'>
        <span className='flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'>
          <svg className='h-3.5 w-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth='2.2'
              d='M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
            />
          </svg>
        </span>
        <p className='truncate text-[11px] font-medium leading-snug text-slate-600 dark:text-slate-300'>
          <span className='font-bold text-slate-900 dark:text-white'>Tip:</span>{' '}
          click any{' '}
          <span className='font-semibold text-emerald-600 dark:text-emerald-400'>
            green point
          </span>{' '}
          to open the 360° view — use ← → to step along a street.
        </p>
        <button
          type='button'
          onClick={dismiss}
          aria-label='Dismiss hint'
          className='ml-auto flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-900/5 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-200'
        >
          <svg className='h-3.5 w-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
            <path strokeLinecap='round' strokeLinejoin='round' strokeWidth='2' d='M6 18L18 6M6 6l12 12' />
          </svg>
        </button>
      </div>
    </div>
  );
}
