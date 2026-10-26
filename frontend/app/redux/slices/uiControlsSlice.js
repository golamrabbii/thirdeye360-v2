import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  yaw: 0,
  pitch: 0,
  fov: 75,
  brightness: 1.0,
  contrast: 1.0,
  sharpness: 0.0,
  showControls: true, // Existing component-er visibility control state
};

const uiControlsSlice = createSlice({
  name: 'uiControls',
  initialState,
  reducers: {
    setCameraOrientation: (state, action) => {
      const { yaw, pitch, fov } = action.payload;
      if (yaw !== undefined) state.yaw = yaw;
      if (pitch !== undefined) {
        state.pitch = Math.max(-85, Math.min(85, pitch));
      }
      if (fov !== undefined) {
        state.fov = Math.max(30, Math.min(110, fov));
      }
    },
    setImageAdjustments: (state, action) => {
      const { brightness, contrast, sharpness } = action.payload;
      if (brightness !== undefined) state.brightness = brightness;
      if (contrast !== undefined) state.contrast = contrast;
      if (sharpness !== undefined) state.sharpness = sharpness;
    },
    resetCamera: (state) => {
      state.yaw = 0;
      state.pitch = 0;
      state.fov = 75;
    },
    toggleControlsVisibility: (state, action) => {
      if (action.payload !== undefined) {
        state.showControls = action.payload;
      } else {
        state.showControls = !state.showControls;
      }
    },
  },
});

export const {
  setCameraOrientation,
  setImageAdjustments,
  resetCamera,
  toggleControlsVisibility,
} = uiControlsSlice.actions;

// Exporting required selector for PannellumViewer / ImageViewer
export const selectShowControls = (state) => state.uiControls.showControls;

export default uiControlsSlice.reducer;