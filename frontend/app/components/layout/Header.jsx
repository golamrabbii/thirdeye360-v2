'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useAuth } from '../../context/AuthContext';
import { apiUrl } from '../../config/api';
import { useTheme } from '../../context/ThemeContext';
import LoginModal from '../ui/LoginModal';

const NAV_TABS = ['Analytics'];

const NAV_ACTIVE =
  'px-3.5 py-1.5 rounded-xl text-xs font-bold text-emerald-800 bg-emerald-100/70 border border-emerald-200/60 shadow-xs hover:bg-emerald-100 transition-all';
const NAV_IDLE =
  'px-3.5 py-1.5 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100/90 dark:hover:bg-slate-800/90 transition-all';

function getInitials(user) {
  const source = user?.name || user?.email || '';
  if (!source) return '?';
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function getRoleLine(user) {
  return user?.role || user?.email || 'Member';
}

export default function Header({ showDarkModeToggle = true }) {
  const { isAuthenticated, isAdmin, user, isLoading, logout } = useAuth();
  const { darkMode, toggleDarkMode } = useTheme();
  const pathname = usePathname();
  // The nav highlights the tab matching the current page: the map page is
  // "Explore Dhaka", /analytics is "Analytics".
  const activeTab = pathname === '/analytics' ? 'Analytics' : 'Explore Dhaka';

  // Live total coverage (all districts, all time) for the navbar metric.
  const [activeCoverage, setActiveCoverage] = useState(null);
  useEffect(() => {
    fetch(apiUrl('/api/coverage/districts'))
      .then((r) => r.json())
      .then((d) => {
        const total = (d.districts || []).reduce(
          (s, x) => s + (x.distance_meters || 0),
          0
        );
        setActiveCoverage(total);
      })
      .catch(() => {});
  }, []);

  const [showLoginModal, setShowLoginModal] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [portalMounted, setPortalMounted] = useState(false);
  const profileRef = useRef(null);

  // Portals need a real DOM node — only render after hydration
  useEffect(() => {
    setPortalMounted(true);
  }, []);

  // Close the profile dropdown on outside click / Escape.
  useEffect(() => {
    if (!profileOpen) return undefined;
    const handleClickOutside = (event) => {
      if (profileRef.current && !profileRef.current.contains(event.target)) {
        setProfileOpen(false);
      }
    };
    const handleEscape = (event) => {
      if (event.key === 'Escape') setProfileOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [profileOpen]);

  // Escape closes the sign-out confirmation, body scroll locks while open
  // (same simple overflow toggle LoginModal uses).
  useEffect(() => {
    if (!showSignOutConfirm) return undefined;
    const handleEscape = (event) => {
      if (event.key === 'Escape') setShowSignOutConfirm(false);
    };
    document.addEventListener('keydown', handleEscape);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = previous;
    };
  }, [showSignOutConfirm]);

  const handleSignOut = () => {
    setProfileOpen(false);
    setShowSignOutConfirm(true);
  };

  const handleConfirmLogout = () => {
    setShowSignOutConfirm(false);
    logout();
  };

  const handleConfirmOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      setShowSignOutConfirm(false);
    }
  };

  return (
    <header className='relative z-30 h-16 w-full glass-panel border-b border-slate-200/70 dark:border-white/10 shadow-sm px-3 sm:px-4 md:px-7 flex items-center justify-between transition-all duration-300'>
      {/* Brand Identity */}
      <div className='flex min-w-0 items-center space-x-6'>
        <div className='flex min-w-0 items-center space-x-2 sm:space-x-3 group cursor-pointer'>
          {/* Logo Emblem */}
          <div className='relative flex items-center justify-center'>
            <div className='h-10 w-10 rounded-2xl bg-gradient-to-tr from-emerald-600 via-teal-500 to-emerald-400 flex items-center justify-center shadow-lg shadow-emerald-500/25 transition-transform duration-300 group-hover:scale-105 border border-white/40'>
              <svg
                className='w-5 h-5 text-white drop-shadow-sm'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2.2'
                />
                <path
                  d='M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2.2'
                />
              </svg>
            </div>
          </div>
          {/* Brand Titles */}
          <div className='flex min-w-0 flex-col'>
            <div className='flex min-w-0 items-center space-x-2'>
              <span className='truncate text-xl font-extrabold tracking-tight bg-gradient-to-r from-slate-950 via-slate-900 to-emerald-700 dark:from-white dark:via-slate-100 dark:to-emerald-400 bg-clip-text text-transparent'>
                ThirdEye<span className='text-emerald-600'>360</span>
              </span>
            </div>
            <span className='truncate text-[11px] font-medium text-slate-500 dark:text-slate-400 tracking-tight'>
              Geospatial Panoramic Platform
            </span>
          </div>
        </div>
        {/* Navigation Tabs (active tab follows the current page) */}
        <nav className='hidden lg:flex items-center space-x-1 pl-5 border-l border-slate-200/80 dark:border-white/10'>
          <Link href='/' className={activeTab === 'Explore Dhaka' ? NAV_ACTIVE : NAV_IDLE}>
            Explore Map
          </Link>
          {NAV_TABS.map((tab) =>
            tab === 'Analytics' ? (
              <Link
                key={tab}
                href='/analytics'
                className={activeTab === 'Analytics' ? NAV_ACTIVE : NAV_IDLE}
              >
                {tab}
              </Link>
            ) : (
              <button key={tab} className={NAV_IDLE}>
                {tab}
              </button>
            )
          )}
        </nav>
      </div>

      {/* Header Right Actions */}
      <div className='flex shrink-0 items-center space-x-2 sm:space-x-3'>
        {/* Quick Status Metric */}
        <div className='hidden sm:flex items-center space-x-2.5 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md px-3.5 py-1.5 rounded-full border border-slate-200/80 dark:border-white/10 shadow-xs text-xs'>
          <span className='relative flex h-2 w-2'>
            <span className='animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75'></span>
            <span className='relative inline-flex rounded-full h-2 w-2 bg-emerald-500'></span>
          </span>
          <span className='font-medium text-slate-600 dark:text-slate-300'>
            Active Coverage:{' '}
            <strong className='font-bold text-slate-900 dark:text-white'>
              {activeCoverage != null
                ? `${(activeCoverage / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`
                : '…'}
            </strong>
          </span>
        </div>
        {/* Theme Switcher (hidden on pages that opt out) */}
        {showDarkModeToggle && (
        <button
          type='button'
          onClick={toggleDarkMode}
          aria-label='Toggle Theme'
          className='p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-white/80 dark:hover:bg-slate-800/80 transition-all border border-transparent hover:border-slate-200/80 dark:hover:border-white/10 shadow-xs'
        >
          {darkMode ? (
            <svg
              className='w-5 h-5'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth='2'
                d='M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z'
              />
            </svg>
          ) : (
            <svg
              className='w-5 h-5'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth='2'
                d='M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z'
              />
            </svg>
          )}
        </button>
        )}
        {/* Settings Icon */}
        <button
          type='button'
          aria-label='Map Settings'
          className='hidden sm:flex p-2 rounded-xl text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-white/80 dark:hover:bg-slate-800/80 transition-all border border-transparent hover:border-slate-200/80 dark:hover:border-white/10 shadow-xs'
        >
          <svg
            className='w-5 h-5'
            fill='none'
            stroke='currentColor'
            viewBox='0 0 24 24'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth='2'
              d='M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4'
            />
          </svg>
        </button>

        {/* Auth-aware actions (skeleton while auth state is resolving) */}
        {isLoading ? (
          <div
            aria-hidden='true'
            className='w-28 h-9 rounded-xl bg-slate-200/60 dark:bg-slate-700/50 animate-pulse'
          />
        ) : isAuthenticated ? (
          <>
            {/* Upload 360° — dedicated page in a new tab (admins only) */}
            {isAdmin && (
            <Link
              href='/upload'
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center space-x-2 px-3.5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-md shadow-emerald-600/25 transition-all text-xs font-bold active:scale-95 border border-white/20'
            >
              <svg
                className='w-4 h-4'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2.2'
                  d='M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12'
                />
              </svg>
              <span className='hidden sm:inline'>Upload 360°</span>
            </Link>
            )}
            {/* Logged-in User Profile Pill */}
            <div className='relative' ref={profileRef}>
              <button
                type='button'
                onClick={() => setProfileOpen((open) => !open)}
                className='flex items-center space-x-2.5 pl-2 py-1 pr-3 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md rounded-xl border border-slate-200/80 dark:border-white/10 shadow-xs hover:border-emerald-300 dark:hover:border-emerald-500/40 transition-all cursor-pointer group'
              >
                <div className='relative flex items-center justify-center'>
                  <div className='w-8 h-8 rounded-lg bg-gradient-to-tr from-emerald-600 to-teal-500 text-white font-bold text-xs flex items-center justify-center shadow-xs'>
                    {getInitials(user)}
                  </div>
                  <span className='absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 border-2 border-white dark:border-slate-800 rounded-full'></span>
                </div>
                <div className='hidden md:flex flex-col text-left max-w-[10rem]'>
                  <span className='text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight truncate group-hover:text-emerald-700 dark:group-hover:text-emerald-400 transition-colors'>
                    {user?.name || 'Signed In'}
                  </span>
                </div>
                <svg
                  className={`w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300 transition-colors ${
                    profileOpen ? 'rotate-180' : ''
                  }`}
                  fill='none'
                  stroke='currentColor'
                  viewBox='0 0 24 24'
                >
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2'
                    d='M19 9l-7 7-7-7'
                  />
                </svg>
              </button>
              {/* Account Dropdown */}
              {profileOpen && (
                <div className='absolute right-0 top-full mt-2 w-60 glass-panel rounded-2xl shadow-xl border border-slate-200/80 dark:border-white/10 p-2 scale-in origin-top-right'>
                  <div className='px-3 py-2 border-b border-slate-200/70 dark:border-white/10'>
                    <p className='text-xs font-bold text-slate-800 dark:text-slate-100 truncate'>
                      {user?.name || 'Signed In'}
                    </p>
                    <p className='text-[10px] font-medium text-slate-500 dark:text-slate-400 truncate'>
                      {user?.email || getRoleLine(user)}
                    </p>
                  </div>
                  <button
                    type='button'
                    onClick={handleSignOut}
                    className='mt-1 w-full flex items-center space-x-2 px-3 py-2 rounded-xl text-xs font-semibold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors'
                  >
                    <svg
                      className='w-4 h-4'
                      fill='none'
                      stroke='currentColor'
                      viewBox='0 0 24 24'
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        strokeWidth='2'
                        d='M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1'
                      />
                    </svg>
                    <span>Sign Out</span>
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          /* Login / Account Button */
          <button
            type='button'
            onClick={() => setShowLoginModal(true)}
            className='flex items-center space-x-2 px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-md shadow-emerald-600/25 transition-all text-xs font-bold active:scale-95'
          >
            <svg
              className='w-4 h-4'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth='2'
                d='M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1'
              />
            </svg>
            <span>Sign In</span>
          </button>
        )}
      </div>

      {/* Self-managed modals — portalled to <body> because the header's
          backdrop-filter makes it the containing block for position:fixed
          descendants, which would confine the modals to the 64px header bar */}
      {portalMounted &&
        createPortal(
          <LoginModal
            isOpen={showLoginModal}
            onClose={() => setShowLoginModal(false)}
          />,
          document.body
        )}
      {portalMounted &&
        showSignOutConfirm &&
        createPortal(
          <div
            className='fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 backdrop-blur-sm p-4 transition-all duration-300 fade-in'
            onClick={handleConfirmOverlayClick}
          >
            {/* Confirmation Card */}
            <div
              role='dialog'
              aria-modal='true'
              aria-label='Log out of ThirdEye360'
              className='w-full max-w-sm bg-white rounded-3xl shadow-2xl border border-slate-200/80 p-6 transition-all scale-in'
            >
              {/* Icon Tile */}
              <div className='w-11 h-11 rounded-2xl bg-rose-50 border border-rose-100/80 flex items-center justify-center text-rose-600 shadow-sm'>
                <svg
                  className='w-6 h-6'
                  fill='none'
                  viewBox='0 0 24 24'
                  stroke='currentColor'
                >
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2.2'
                    d='M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1'
                  />
                </svg>
              </div>
              <h2 className='mt-4 text-base font-bold text-slate-900 tracking-tight'>
                Log out of ThirdEye360?
              </h2>
              <p className='mt-1 text-xs text-slate-500 leading-relaxed'>
                You will need to sign in again to access surveyor tools and
                upload imagery.
              </p>
              {/* Actions */}
              <div className='grid grid-cols-2 gap-3 mt-6'>
                <button
                  type='button'
                  onClick={() => setShowSignOutConfirm(false)}
                  className='py-2.5 px-4 rounded-xl border border-slate-200 hover:border-slate-300 hover:bg-slate-50/80 text-xs font-bold text-slate-600 shadow-xs transition-all'
                >
                  Cancel
                </button>
                <button
                  type='button'
                  onClick={handleConfirmLogout}
                  className='py-2.5 px-4 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-700 hover:to-rose-600 text-white text-xs font-bold shadow-lg shadow-rose-600/25 active:scale-95 transition-all'
                >
                  Log Out
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </header>
  );
}
