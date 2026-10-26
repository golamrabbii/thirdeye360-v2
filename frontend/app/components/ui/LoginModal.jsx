'use client';

import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { getAuthInstance } from '../../utils/barikoiAuth';

const LoginModal = ({ isOpen, onClose }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Pre-fill remembered credentials.
  useEffect(() => {
    if (isOpen) {
      const savedEmail = localStorage.getItem('thirdeye_remembered_email');
      const savedPassword = localStorage.getItem('thirdeye_remembered_pass');
      const savedRememberMe = localStorage.getItem('thirdeye_remember_me');

      if (savedEmail) {
        setEmail(savedEmail);
        if (savedRememberMe === 'true' && savedPassword) {
          setPassword(savedPassword);
          setRememberMe(true);
        }
      }
    }
  }, [isOpen]);

  // Lock body scroll while open.
  useEffect(() => {
    if (isOpen) {
      const previous = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = previous;
      };
    }
    return undefined;
  }, [isOpen]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Please enter both email and password');
      return;
    }

    setIsLoading(true);

    try {
      const auth = getAuthInstance();
      await auth.login(email, password);

      if (rememberMe) {
        localStorage.setItem('thirdeye_remembered_email', email);
        localStorage.setItem('thirdeye_remembered_pass', password);
        localStorage.setItem('thirdeye_remember_me', 'true');
      } else {
        localStorage.removeItem('thirdeye_remembered_email');
        localStorage.removeItem('thirdeye_remembered_pass');
        localStorage.removeItem('thirdeye_remember_me');
      }

      onClose();
    } catch (err) {
      setError(err.message || 'Authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Decorative actions (no real flows wired up yet) -> toast feedback.
  const handleRequestAccess = () => {
    toast('Access requests go through your Barikoi account manager.');
  };

  if (!isOpen) return null;

  return (
    <div
      className='fixed inset-0 z-50 flex flex-col items-center overflow-y-auto p-4 py-8 bg-slate-950/50 backdrop-blur-sm transition-all duration-300 fade-in'
      onClick={handleOverlayClick}
    >
      {/* Modal Container Card — vertically centered, scrolls on short viewports */}
      <div
        role='dialog'
        aria-modal='true'
        aria-label='Sign in to your account'
        className='relative my-auto w-full max-w-[460px] shrink-0 bg-white rounded-3xl shadow-2xl border border-slate-200/80 p-5 sm:p-8 overflow-hidden transition-all scale-in'
      >
        {/* Top Decorative Gradient Glow */}
        <div className='absolute top-0 inset-x-0 h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-400' />

        {/* Close Button */}
        <button
          type='button'
          onClick={onClose}
          aria-label='Close modal'
          className='absolute top-5 right-5 w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all'
        >
          <svg
            className='w-5 h-5'
            fill='none'
            viewBox='0 0 24 24'
            stroke='currentColor'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth={2}
              d='M6 18L18 6M6 6l12 12'
            />
          </svg>
        </button>

        {/* Header & Brand */}
        <div className='flex flex-col items-start'>
          <div className='flex items-center space-x-3 mb-4'>
            <div className='w-11 h-11 rounded-2xl bg-emerald-50 border border-emerald-100/80 flex items-center justify-center text-emerald-600 shadow-sm'>
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
                  d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'
                />
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2.2'
                  d='M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z'
                />
              </svg>
            </div>
            <div>
              <div className='flex items-center space-x-2'>
                <span className='font-extrabold text-slate-900 tracking-tight text-base'>
                  ThirdEye<span className='text-emerald-600'>360</span>
                </span>
                <span className='text-[10px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full border border-emerald-200/60'>
                  Surveyor Pro
                </span>
              </div>
              <span className='text-xs text-slate-500 font-medium'>
                Geospatial Intelligence Platform
              </span>
            </div>
          </div>
          <h2 className='text-xl font-bold text-slate-900 tracking-tight'>
            Sign in to your account
          </h2>
          <p className='text-xs text-slate-500 mt-1 leading-relaxed'>
            Enter your geospatial credentials to access 360° coverage networks,
            data annotations &amp; surveyor tools.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className='space-y-4 mt-6'>
          {/* Email Input */}
          <div>
            <label
              htmlFor='email'
              className='block text-xs font-semibold text-slate-700 mb-1.5'
            >
              Work Email
            </label>
            <div className='relative rounded-xl shadow-xs'>
              <div className='absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400'>
                <svg
                  className='w-4 h-4'
                  fill='none'
                  viewBox='0 0 24 24'
                  stroke='currentColor'
                >
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth={2}
                    d='M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.206'
                  />
                </svg>
              </div>
              <input
                type='email'
                id='email'
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete='email'
                placeholder='tanvir.ahmed@barikoi.com'
                className='block w-full pl-10 pr-3.5 py-2.5 text-xs text-slate-900 border border-slate-200 rounded-xl bg-slate-50/50 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all'
              />
            </div>
          </div>

          {/* Password Input */}
          <div>
            <label
              htmlFor='password'
              className='block text-xs font-semibold text-slate-700 mb-1.5'
            >
              Password
            </label>
            <div className='relative rounded-xl shadow-xs'>
              <div className='absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400'>
                <svg
                  className='w-4 h-4'
                  fill='none'
                  viewBox='0 0 24 24'
                  stroke='currentColor'
                >
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth={2}
                    d='M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z'
                  />
                </svg>
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                id='password'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete='current-password'
                placeholder='••••••••••••'
                className='block w-full pl-10 pr-10 py-2.5 text-xs text-slate-900 border border-slate-200 rounded-xl bg-slate-50/50 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all'
              />
              <button
                type='button'
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className='absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600'
              >
                {showPassword ? (
                  <svg
                    className='w-4 h-4'
                    fill='none'
                    viewBox='0 0 24 24'
                    stroke='currentColor'
                  >
                    <path
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      strokeWidth={2}
                      d='M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21'
                    />
                  </svg>
                ) : (
                  <svg
                    className='w-4 h-4'
                    fill='none'
                    viewBox='0 0 24 24'
                    stroke='currentColor'
                  >
                    <path
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      strokeWidth={2}
                      d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'
                    />
                    <path
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      strokeWidth={2}
                      d='M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z'
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Remember Me & Trust Device */}
          <div className='flex items-center justify-between pt-0.5'>
            <label className='flex items-center space-x-2 cursor-pointer'>
              <input
                type='checkbox'
                id='rememberMe'
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className='w-4 h-4 rounded text-emerald-600 border-slate-300 focus:ring-emerald-500 focus:ring-offset-0 transition-colors cursor-pointer'
              />
              <span className='text-xs text-slate-600 font-medium select-none'>
                Remember this device for 30 days
              </span>
            </label>
          </div>

          {/* Submit Button */}
          <button
            type='submit'
            disabled={isLoading}
            className='w-full mt-2 py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-600 hover:from-emerald-700 hover:to-teal-700 text-white text-xs font-bold shadow-lg shadow-emerald-600/25 active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed disabled:active:scale-100 transition-all flex items-center justify-center space-x-2'
          >
            {isLoading ? (
              <>
                <svg
                  className='animate-spin w-4 h-4'
                  fill='none'
                  viewBox='0 0 24 24'
                >
                  <circle
                    className='opacity-25'
                    cx='12'
                    cy='12'
                    r='10'
                    stroke='currentColor'
                    strokeWidth='4'
                  />
                  <path
                    className='opacity-75'
                    fill='currentColor'
                    d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
                  />
                </svg>
                <span>Signing In...</span>
              </>
            ) : (
              <>
                <span>Sign In to Dashboard</span>
                <svg
                  className='w-4 h-4'
                  fill='none'
                  viewBox='0 0 24 24'
                  stroke='currentColor'
                >
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    strokeWidth='2.2'
                    d='M14 5l7 7m0 0l-7 7m7-7H3'
                  />
                </svg>
              </>
            )}
          </button>

          {/* Inline Error Banner */}
          {error && (
            <div className='flex items-start space-x-2 p-3 rounded-xl bg-rose-50 border border-rose-200'>
              <svg
                className='w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5'
                fill='none'
                viewBox='0 0 24 24'
                stroke='currentColor'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={2}
                  d='M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'
                />
              </svg>
              <p className='text-xs font-semibold text-rose-600'>{error}</p>
            </div>
          )}
        </form>

        {/* Modal Footer */}
        <div className='mt-6 pt-4 border-t border-slate-100 flex flex-col items-center space-y-2 text-center'>
          <p className='text-xs text-slate-500'>
            Don&apos;t have surveyor credentials?{' '}
            <button
              type='button'
              onClick={handleRequestAccess}
              className='font-bold text-emerald-600 hover:text-emerald-700 hover:underline'
            >
              Request Access
            </button>
          </p>
          <div className='flex items-center space-x-1.5 text-[10px] text-slate-400 font-medium tracking-tight'>
            <svg
              className='w-3.5 h-3.5 text-emerald-600'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={2}
                d='M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z'
              />
            </svg>
            <span>Secured with 256-bit TLS • Barikoi Geospatial Engine</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginModal;
