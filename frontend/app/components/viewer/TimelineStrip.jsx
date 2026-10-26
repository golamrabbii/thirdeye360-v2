'use client';

import { PiCaretLeftBold, PiClockBold } from 'react-icons/pi';

/**
 * Street View-style timeline strip: horizontal date cards at the bottom of
 * the pano view. Newest capture first ("Latest" badge); clicking a card
 * jumps to the nearest frame of that date. "Back to latest" returns to the
 * newest capture.
 */

const fmtMonth = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
};
const fmtDay = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export default function TimelineStrip({
  dates = [],
  loading = false,
  error = '',
  activeDate = null, // capture day of the frame currently on screen
  onSelect = () => {},
  onBackToLatest = () => {},
  onClose = () => {},
}) {
  const newest = dates.find((d) => d.latest) || dates[0] || null;
  const onLatest = activeDate != null && newest && activeDate === newest.date;

  return (
    <div
      className='pointer-events-auto absolute inset-x-0 bottom-0 z-40 border-t border-white/10 bg-slate-950/85 backdrop-blur-md'
      role='region'
      aria-label='Capture timeline'
    >
      <div className='flex items-center justify-between px-4 pb-1 pt-2'>
        <div className='flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-300'>
          <PiClockBold className='text-emerald-400' />
          Timeline
          {onLatest && (
            <span className='rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-emerald-300'>
              Latest
            </span>
          )}
        </div>
        <div className='flex items-center gap-2'>
          {!onLatest && newest && (
            <button
              type='button'
              onClick={() => onBackToLatest(newest)}
              className='rounded-full bg-emerald-500/20 px-2.5 py-1 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/30'
            >
              Back to latest
            </button>
          )}
          <button
            type='button'
            onClick={onClose}
            aria-label='Close timeline'
            className='rounded-full px-2 py-1 text-[11px] text-slate-400 transition-colors hover:text-white'
          >
            ✕
          </button>
        </div>
      </div>

      <div className='flex gap-2 overflow-x-auto px-4 pb-3 pt-1'>
        {loading &&
          Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className='h-16 w-32 shrink-0 animate-pulse rounded-xl border border-white/10 bg-white/5'
            />
          ))}

        {!loading && error && (
          <div className='py-3 text-[12px] text-rose-300'>{error}</div>
        )}

        {!loading && !error && dates.length === 0 && (
          <div className='py-3 text-[12px] text-slate-400'>
            No other capture dates for this location.
          </div>
        )}

        {!loading &&
          dates.map((entry) => {
            const isActive = activeDate === entry.date;
            return (
              <button
                key={entry.date}
                type='button'
                onClick={() => onSelect(entry)}
                className={`group h-16 w-36 shrink-0 rounded-xl border px-3 text-left transition-colors ${
                  isActive
                    ? 'border-emerald-400/70 bg-emerald-500/15'
                    : 'border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10'
                }`}
              >
                <div className='flex items-center justify-between'>
                  <span className='text-[12px] font-semibold text-white'>
                    {fmtMonth(entry.date)}
                  </span>
                  {entry.latest && (
                    <span className='rounded-full bg-emerald-500/25 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300'>
                      Latest
                    </span>
                  )}
                </div>
                <div className='mt-0.5 text-[11px] text-slate-300'>
                  {fmtDay(entry.date)} · {entry.count} photos
                </div>
              </button>
            );
          })}
      </div>
    </div>
  );
}
