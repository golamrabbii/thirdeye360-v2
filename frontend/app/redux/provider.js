"use client";

import { Provider } from "react-redux";
import store from "./store";

/**
 * Redux provider component for client components
 * This makes the Redux store available to all components in the application
 */
export default function ReduxProvider({ children }) {
  return <Provider store={store}>{children}</Provider>;
}
