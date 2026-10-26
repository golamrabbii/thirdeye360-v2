'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { apiUrl } from '../config/api';
import Header from '../components/layout/Header';
import { useTheme } from '../context/ThemeContext';

/*
 * Coverage Analytics — follows frontend_v2/analytics.html (reference design):
 * dot-grid canvas, KPI banner, teal uniform bar charts with mono value
 * labels, and a Google-style dual-month date-range picker.
 * Data hue: #0d9488 (teal-600). Single-series charts → no legend needed.
 */

const TOTAL_DISTRICTS = 64;

const toISO = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Default analytics window: the last 7 COMPLETE days, ending yesterday —
// today's capture is still in progress, so it stays out of the charts.
const defaultWindow = () => {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return { start: toISO(start), end: toISO(end) };
};

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']; // Monday-first
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const dayMeta = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const moIdx = (dt.getDay() + 6) % 7; // Monday-first column index
  return {
    weekday: WEEKDAYS[moIdx],
    label: `${d} ${MONTHS_SHORT[m - 1]}`,
    isWeekend: moIdx >= 5,
  };
};

const fmtDDMMYYYY = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}`;
};

const fmtKm = (meters) =>
  `${((meters || 0) / 1000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;

/** Chart labels: km with 2 decimals so bar and axis read the same. */
const fmtKmPrecise = (meters) =>
  `${((meters || 0) / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} km`;

/** Clean chart max: rounds up to a 1/2/2.5/5-step number. */
const niceMax = (v) => {
  if (v <= 0) return 1000;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return f * pow;
};

/* --------------------- dual-month date-range picker --------------------- */

function buildMonthCells(year, month /*0-based*/) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const rows = Math.ceil((offset + daysInMonth) / 7);
  const start = new Date(year, month, 1 - offset);
  const cells = [];
  for (let i = 0; i < rows * 7; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      iso: toISO(d),
      day: d.getDate(),
      inMonth: d.getMonth() === month,
    });
  }
  return { cells, rows };
}

function DateRangePicker({ initialStart, initialEnd, dataDays, dark, onApply }) {
  const initMonth = initialEnd
    ? (() => {
        const [y, m] = initialEnd.split('-').map(Number);
        return { y, m: m - 1 };
      })()
    : (() => {
        const t = new Date();
        return { y: t.getFullYear(), m: t.getMonth() };
      })();
  const [view, setView] = useState(initMonth); // left month; right = +1
  const [selStart, setSelStart] = useState(initialStart || null);
  const [selEnd, setSelEnd] = useState(initialEnd || null);
  const [hover, setHover] = useState(null);
  const panelCls = dark
    ? 'bg-slate-900 border-slate-700'
    : 'bg-white border-slate-200';
  const faint = dark ? 'text-slate-600' : 'text-slate-300';
  const ink = dark ? 'text-slate-100' : 'text-slate-900';
  const ink2 = dark ? 'text-slate-400' : 'text-slate-400';
  const gridHover = dark ? 'hover:bg-slate-800' : 'hover:bg-slate-50';

  const shiftViewMonth = (delta) =>
    setView((v) => (v.m + delta < 0 ? { y: v.y - 1, m: 11 } : v.m + delta > 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + delta }));

  const pick = (iso) => {
    // First click sets the start; second click sets the end (auto-swap when
    // the end lands before the start, Google-style).
    if (!selStart || (selStart && selEnd)) {
      setSelStart(iso);
      setSelEnd(null);
    } else if (iso < selStart) {
      setSelEnd(selStart);
      setSelStart(iso);
    } else if (iso === selStart) {
      setSelEnd(iso);
    } else {
      setSelEnd(iso);
    }
  };

  const inBand = (iso) => {
    if (!selStart) return false;
    const end = selEnd ?? (hover && selStart ? hover : null);
    if (!end) return false;
    const [lo, hi] = selStart <= end ? [selStart, end] : [end, selStart];
    return iso > lo && iso < hi;
  };

  const renderMonth = (year, month) => {
    const { cells, rows } = buildMonthCells(year, month);
    return (
      <div className='flex-1 min-w-0'>
        <div className='grid grid-cols-7 mb-1'>
          {WEEKDAYS.map((w) => (
            <div key={w} className={`text-center text-[10px] font-semibold uppercase tracking-wider ${ink2} py-1`}>
              {w}
            </div>
          ))}
        </div>
        <div className='grid grid-cols-7 gap-y-1'>
          {cells.map((c) => {
            const hasData = dataDays.has(c.iso);
            const isStart = c.iso === selStart;
            const isEnd = c.iso === selEnd;
            const band = inBand(c.iso);
            const selected = isStart || isEnd;
            const weekend = dayMeta(c.iso).isWeekend;
            let cellCls = `relative w-9 h-9 mx-auto flex items-center justify-center text-[12.5px] font-medium select-none `;
            if (selected) cellCls += 'bg-[#0d9488] text-white rounded-lg font-bold shadow-sm';
            else if (band) cellCls += `bg-teal-100/80 text-teal-900 ${dark ? 'dark:bg-teal-500/20 dark:text-teal-200' : ''} rounded-md`;
            else if (!c.inMonth) cellCls += faint;
            else cellCls += `${weekend ? 'text-teal-700 dark:text-teal-400' : ink} ${gridHover} rounded-lg cursor-pointer`;
            return (
              <div key={c.iso} className='flex justify-center'>
                <button
                  type='button'
                  onClick={() => pick(c.iso)}
                  onMouseEnter={() => setHover(c.iso)}
                  onMouseLeave={() => setHover(null)}
                  className={cellCls}
                >
                  {c.day}
                  {hasData && !selected && (
                    <span className='absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-teal-500' />
                  )}
                </button>
              </div>
            );
          })}
        </div>
        {/* keep consistent height across the two months */}
        {rows < 6 && <div style={{ height: (6 - rows) * 36 }} />}
      </div>
    );
  };

  const ready = selStart && selEnd;

  return (
    <div
      className={`absolute left-0 top-full mt-2 z-30 w-[620px] max-w-[92vw] rounded-xl border ${panelCls} shadow-2xl`}
    >
      <div className='p-5'>
        {/* Month navigation */}
        <div className='flex items-center justify-between mb-3'>
          <button
            type='button'
            onClick={() => shiftViewMonth(-1)}
            className={`w-8 h-8 rounded-lg ${dark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-500'} flex items-center justify-center transition-colors`}
            aria-label='Previous month'
          >
            <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path strokeLinecap='round' strokeLinejoin='round' strokeWidth='2' d='M15 19l-7-7 7-7' />
            </svg>
          </button>
          <div className='flex-1 grid grid-cols-2'>
            <div className={`text-center text-sm font-bold ${ink}`}>{MONTHS[view.m]} {view.y}</div>
            <div className={`text-center text-sm font-bold ${ink}`}>
              {view.m === 11 ? `${MONTHS[0]} ${view.y + 1}` : `${MONTHS[view.m + 1]} ${view.y}`}
            </div>
          </div>
          <button
            type='button'
            onClick={() => shiftViewMonth(1)}
            className={`w-8 h-8 rounded-lg ${dark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-500'} flex items-center justify-center transition-colors`}
            aria-label='Next month'
          >
            <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path strokeLinecap='round' strokeLinejoin='round' strokeWidth='2' d='M9 5l7 7-7 7' />
            </svg>
          </button>
        </div>

        {/* Two month grids side by side */}
        <div className='flex gap-6'>
          {renderMonth(view.y, view.m)}
          {renderMonth(view.m === 11 ? view.y + 1 : view.y, view.m === 11 ? 0 : view.m + 1)}
        </div>
      </div>

      {/* Apply */}
      <div className='px-5 py-3 flex items-center justify-end'>
        <button
          type='button'
          disabled={!ready}
          onClick={() => ready && onApply(selStart, selEnd)}
          className='inline-flex items-center gap-1.5 px-4 py-2 bg-[#0d9488] hover:bg-teal-700 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
        >
          <svg className='w-3.5 h-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
            <path strokeLinecap='round' strokeLinejoin='round' strokeWidth='2.5' d='M5 13l4 4L19 7' />
          </svg>
          Apply Date Range
        </button>
      </div>
    </div>
  );
}

/* ------------------------- scrollable bar chart ------------------------- */

function BarChart({ entries, dark, valueFmt }) {
  const max = useMemo(
    () => niceMax(Math.max(...entries.map((e) => e.value), 1)),
    [entries]
  );
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => ({ f, v: max * f }));
  const grid = dark ? 'border-slate-800' : 'border-slate-100';
  const gridStrong = dark ? 'border-slate-700' : 'border-slate-300/70';
  const ink = dark ? 'text-slate-100' : 'text-slate-900';
  const ink2 = 'text-slate-400';
  // Responsive slotting: columns share the card width, so the gap between
  // bars shrinks automatically as the data grows.
  const colsStyle = {
    gridTemplateColumns: `repeat(${entries.length}, minmax(0, 1fr))`,
  };

  return (
    <div>
        <div className='relative w-full h-56 flex flex-col justify-end'>
          <div className='absolute inset-0 flex flex-col justify-between pointer-events-none'>
            {ticks.map(({ f, v }) => (
              <div key={f} className='w-full flex items-center'>
                <span className={`text-[11px] font-mono ${ink2} w-14 text-right pr-3`}>{fmtKm(v)}</span>
                <div className={`flex-1 border-b ${f === 0 ? gridStrong : grid}`} />
              </div>
            ))}
          </div>
          <div
            className='relative ml-14 h-48 grid items-end px-2 sm:px-4 z-10 gap-1.5 sm:gap-2'
            style={colsStyle}
          >
            {entries.map((e) => (
              <div
                key={e.key}
                className='flex flex-col items-center h-full justify-end group'
                title={`${valueFmt(e.value)}${e.points != null ? ` · ${e.points.toLocaleString()} pts` : ''}`}
              >
                {entries.length <= 14 && (
                  <span className='font-mono text-[10.5px] font-semibold text-slate-600 dark:text-slate-300 mb-1 whitespace-nowrap'>
                    {valueFmt(e.value)}
                  </span>
                )}
                <div
                  className='w-full max-w-[44px] bg-[#0d9488] rounded-t transition-opacity hover:opacity-90'
                  style={{ height: `${Math.max((e.value / max) * 100, 0.6)}%` }}
                />
              </div>
            ))}
          </div>
        </div>
        {/* X-axis labels */}
        <div
          className='ml-14 grid px-2 sm:px-4 pt-2.5 text-center border-t border-slate-200 dark:border-slate-700 gap-1.5 sm:gap-2'
          style={colsStyle}
        >
          {entries.map((e) => (
            <div key={e.key}>
              <div className={`text-[11px] font-semibold ${ink} truncate`} title={e.label}>
                {e.label}
              </div>
            </div>
          ))}
        </div>
      </div>
  );
}

/* ------------------- district horizontal bar list ------------------- */

function DistrictBarList({ districts, dark }) {
  const rows = useMemo(
    () =>
      (districts || [])
        .slice()
        .sort((a, b) => b.distance_meters - a.distance_meters),
    [districts]
  );
  const max = Math.max(...rows.map((r) => r.distance_meters), 1);
  const ink = dark ? 'text-slate-100' : 'text-slate-900';
  const ink2 = dark ? 'text-slate-500' : 'text-slate-400';
  const track = dark ? 'bg-slate-800' : 'bg-slate-100';

  return (
    <div className='space-y-5 pt-1'>
      {rows.map((r, i) => (
        <div key={r.district_name}>
          <div className='flex items-center gap-3 mb-2'>
            <span className={`font-mono text-xs ${ink2}`}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className={`text-sm font-semibold ${ink}`}>{r.district_name}</span>
            <span className={`ml-auto font-mono text-xs font-semibold ${ink}`}>
              {fmtKmPrecise(r.distance_meters)}
            </span>
          </div>
          <div className={`h-2 w-full rounded-full ${track}`}>
            <div
              className='h-full rounded-full bg-[#0d9488]'
              style={{ width: `${Math.max((r.distance_meters / max) * 100, 1)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------- page ------------------------------- */

export default function AnalyticsPage() {
  const { darkMode } = useTheme();
  const [districts, setDistricts] = useState(null);
  const [dailyDays, setDailyDays] = useState(null);
  const [win, setWin] = useState({ start: '', end: '' }); // applied window
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState(null);
  const pickerRef = useRef(null);

  const dataDays = useMemo(
    () =>
      new Set(
        (dailyDays || []).filter((d) => d.point_count > 0).map((d) => d.day)
      ),
    [dailyDays]
  );

  const loadDaily = (start = '', end = '') => {
    setError(null);
    const w = start && end ? { start, end } : defaultWindow();
    const q = w.start && w.end ? `?start_date=${w.start}&end_date=${w.end}` : '';
    fetch(apiUrl(`/api/coverage/daily${q}`))
      .then((r) => r.json())
      .then((d) => {
        setDailyDays(d.days || []);
        setWin({ start: d.start_date, end: d.end_date });
      })
      .catch(() => setError('Failed to load daily coverage — is the backend running?'));
  };

  useEffect(() => {
    let active = true;
    fetch(apiUrl('/api/coverage/districts'))
      .then((r) => r.json())
      .then((d) => {
        if (active) setDistricts(d.districts || []);
      })
      .catch(() => {
        if (active) setError('Failed to load district coverage — is the backend running?');
      });
    loadDaily();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the picker on outside click
  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onDown = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  const totalMeters = (districts || []).reduce((s, r) => s + (r.distance_meters || 0), 0);

  // Newest day first (9 Oct before 3 Oct in the Daily Coverage chart)
  const dailyEntries = (dailyDays || [])
    .map((d) => ({
      key: d.day,
      label: dayMeta(d.day).label,
      value: d.distance_meters,
      points: d.point_count,
    }))
    .sort((a, b) => b.key.localeCompare(a.key));
  const districtEntries = (districts || [])
    .slice()
    .sort((a, b) => b.distance_meters - a.distance_meters)
    .map((r) => ({
      key: r.district_name,
      label: r.district_name,
      value: r.distance_meters,
      points: r.point_count,
    }));

  // Dark palette per analytics_dark.html: #070d19 canvas, #0e1626 cards,
  // #1e293b borders, teal-300 accents.
  const pageBg = darkMode
    ? {
        backgroundColor: '#070d19',
        backgroundImage: 'radial-gradient(#1e293b 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }
    : {
        backgroundColor: '#f8fafc',
        backgroundImage: 'radial-gradient(#e2e8f0 1.2px, transparent 1.2px)',
        backgroundSize: '24px 24px',
      };
  const sectionCard = darkMode
    ? 'rounded-xl bg-[#0e1626] border border-[#1e293b] shadow-xs flex flex-col h-full'
    : 'rounded-xl bg-white border border-slate-200/80 shadow-xs flex flex-col';
  const kpiCard = darkMode
    ? 'rounded-xl bg-[#0e1626] border border-[#1e293b] p-6 shadow-xs'
    : 'rounded-xl bg-white border border-slate-200/80 p-6 shadow-xs';
  const ink = darkMode ? 'text-slate-100' : 'text-slate-900';
  const ink2 = darkMode ? 'text-slate-400' : 'text-slate-500';
  const ink3 = darkMode ? 'text-slate-500' : 'text-slate-400';
  const chipCls = darkMode
    ? 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-teal-500/15 text-teal-300 border border-teal-500/30 font-mono'
    : 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-teal-50 text-teal-700 border border-teal-200/60 font-mono';
  const dateInputCls = darkMode
    ? 'bg-slate-900 border-slate-600 text-slate-100 [color-scheme:dark]'
    : 'bg-white border-slate-200 text-slate-800 [color-scheme:light]';
  const pickerBtnCls = darkMode
    ? 'bg-slate-900 border-slate-600 text-slate-100 hover:border-teal-500'
    : 'bg-white border-slate-200 text-slate-700 hover:border-teal-400';

  return (
    <div className='min-h-screen w-full font-sans antialiased' style={pageBg}>
      {/* Same navbar as the home page — dark toggle included */}
      <Header />

      <main className='max-w-[1600px] mx-auto px-6 lg:px-8 space-y-7 pt-8 pb-20'>
        {/* Page header */}
        <header className='flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-2'>
          <div className='space-y-1'>
            <h1 className={`text-2xl lg:text-3xl font-bold tracking-tight ${ink}`}>
              Street View Coverage Analytics
            </h1>
            <p className={`text-sm ${ink2}`}>
              High-precision 360° road network coverage, window velocity, and district progress across Bangladesh.
            </p>
          </div>
        </header>

        {error && (
          <div className='rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400'>
            {error}
          </div>
        )}

        {/* KPI banner */}
        <section className='grid grid-cols-1 md:grid-cols-2 gap-5'>
          {[
            {
              label: 'Total Street View Coverage',
              value: districts ? fmtKm(totalMeters) : '…',
              sub: 'All-time mapped distance across all tracks',
            },
            {
              label: 'Districts Covered',
              value: districts ? `${districts.length} / ${TOTAL_DISTRICTS}` : '…',
              sub: 'Districts with recorded coverage',
            },
          ].map((k) => (
            <div key={k.label} className={kpiCard}>
              <p className={`text-xs font-medium ${ink2}`}>{k.label}</p>
              <p className={`mt-2 text-3xl font-bold ${ink}`}>{k.value}</p>
              <p className={`mt-1 text-[11px] font-medium ${ink3}`}>{k.sub}</p>
            </div>
          ))}
        </section>

        {/* Two charts side by side */}
        <div className='grid grid-cols-1 xl:grid-cols-2 gap-5'>
          {/* Daily Street View Coverage */}
          <section className={sectionCard}>
            <div className='p-5 lg:p-6'>
              <div className='flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4'>
                <div>
                  <h2 className={`text-base font-bold ${ink}`}>Daily Coverage</h2>
                  <p className={`text-xs ${ink2} mt-0.5`}>
                    Linear road kilometres recorded per day with active vehicle runs.
                  </p>
                </div>
                <div className='flex items-center flex-wrap gap-2'>
                  <div className='relative' ref={pickerRef}>
                    <button
                      type='button'
                      onClick={() => setPickerOpen((o) => !o)}
                      className={`flex items-center border rounded-lg px-3 py-1.5 shadow-xs text-xs transition-colors ${pickerBtnCls}`}
                    >
                      <svg className='w-3.5 h-3.5 text-slate-400 mr-2' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                        <path strokeLinecap='round' strokeLinejoin='round' strokeWidth='2' d='M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z' />
                      </svg>
                      <span className='font-mono font-medium text-[11px]'>
                        {win.start && win.end
                          ? `${fmtDDMMYYYY(win.start)} – ${fmtDDMMYYYY(win.end)}`
                          : 'Pick a range'}
                      </span>
                      <svg className='w-3.5 h-3.5 text-slate-400 ml-1.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                        <path strokeLinecap='round' strokeLinejoin='round' strokeWidth='2' d='M19 9l-7 7-7-7' />
                      </svg>
                    </button>
                    {pickerOpen && (
                      <DateRangePicker
                        initialStart={win.start}
                        initialEnd={win.end}
                        dataDays={dataDays}
                        dark={darkMode}
                        onApply={(s, e) => {
                          setPickerOpen(false);
                          loadDaily(s, e);
                        }}
                      />
                    )}
                  </div>
                </div>
              </div>


              {!dailyDays ? (
                <div className='flex h-64 items-center justify-center'>
                  <div className='h-9 w-9 animate-spin rounded-full border-t-2 border-b-2 border-teal-500' />
                </div>
              ) : dailyEntries.length === 0 ? (
                <div className='flex h-64 items-center justify-center text-xs font-medium text-slate-400'>
                  No daily coverage yet — run a coverage refresh first.
                </div>
              ) : (
                <BarChart entries={dailyEntries} dark={darkMode} valueFmt={fmtKmPrecise} />
              )}
            </div>
          </section>

          {/* District-wise Coverage Breakdown */}
          <section className={sectionCard}>
            <div className='p-5 lg:p-6 flex-1'>
              <div className='flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4'>
                <div>
                  <h2 className={`text-base font-bold ${ink}`}>District Coverage</h2>
                  <p className={`text-xs ${ink2} mt-0.5`}>
                    Total linear road kilometres mapped per district (all time).
                  </p>
                </div>
              </div>

              {!districts ? (
                <div className='flex h-64 items-center justify-center'>
                  <div className='h-9 w-9 animate-spin rounded-full border-t-2 border-b-2 border-teal-500' />
                </div>
              ) : districtEntries.length === 0 ? (
                <div className='flex h-64 items-center justify-center text-xs font-medium text-slate-400'>
                  No district coverage yet — populate the districts table and run a refresh.
                </div>
              ) : (
                <DistrictBarList districts={districts} dark={darkMode} />
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
