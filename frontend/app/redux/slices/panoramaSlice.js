import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  files: [], // Array of image URLs
  currentIndex: 0,
  nextIndex: null,
  isTransitioning: false,
  transitionProgress: 0,
  viewPosition: { yaw: 0, pitch: 0, fov: 75 }, // Existing saved view position
};

const panoramaSlice = createSlice({
  name: 'panorama',
  initialState,
  reducers: {
    setPanoramaFiles: (state, action) => {
      state.files = action.payload;
      if (state.currentIndex >= action.payload.length) {
        state.currentIndex = 0;
      }
    },
    setCurrentIndex: (state, action) => {
      if (action.payload >= 0 && action.payload < state.files.length) {
        state.currentIndex = action.payload;
      }
    },
    nextPanorama: (state) => {
      if (state.files.length > 0) {
        state.currentIndex = (state.currentIndex + 1) % state.files.length;
      }
    },
    prevPanorama: (state) => {
      if (state.files.length > 0) {
        state.currentIndex =
          (state.currentIndex - 1 + state.files.length) % state.files.length;
      }
    },
    setTransitionState: (state, action) => {
      const { isTransitioning, progress, nextIndex } = action.payload;
      if (isTransitioning !== undefined) state.isTransitioning = isTransitioning;
      if (progress !== undefined) state.transitionProgress = progress;
      if (nextIndex !== undefined) state.nextIndex = nextIndex;
    },
    saveViewPosition: (state, action) => {
      state.viewPosition = { ...state.viewPosition, ...action.payload };
    },
  },
});

export const {
  setPanoramaFiles,
  setCurrentIndex,
  nextPanorama,
  prevPanorama,
  setTransitionState,
  saveViewPosition,
} = panoramaSlice.actions;

// Exporting required selector for PannellumViewer
export const selectViewPosition = (state) => state.panorama.viewPosition;

export default panoramaSlice.reducer;