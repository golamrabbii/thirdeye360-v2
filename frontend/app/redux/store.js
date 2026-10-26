import { configureStore } from "@reduxjs/toolkit";
import panoramaReducer from "./slices/panoramaSlice";
import uiControlsReducer from "./slices/uiControlsSlice";

/**
 * Configure the Redux store for the application
 * This combines all reducers and adds middleware
 */
export const store = configureStore({
  reducer: {
    panorama: panoramaReducer,
    uiControls: uiControlsReducer,
    // Add other reducers here as needed
  },
});

export default store;
