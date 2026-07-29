'use client';

/**
 * ToastContext - Manages toast notification state across the application
 * Provides functions to show, dismiss, and manage toast notifications
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  ReactNode,
} from 'react';
import {
  Toast,
  ToastOptions,
  ToastContextValue,
  TOAST_DEFAULTS,
} from '@/types/toast';

/**
 * Create the Toast Context with undefined default value
 * This forces consumers to use the context within a provider
 */
const ToastContext = createContext<ToastContextValue | undefined>(undefined);

/**
 * ToastProvider - Context provider component
 * Wraps the application to provide toast notification functionality
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Track active timeout IDs for cleanup
  const timeoutRefs = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Cleanup all timeouts on unmount
  useEffect(() => {
    const currentTimeoutRefs = timeoutRefs.current;
    return () => {
      currentTimeoutRefs.forEach((timeoutId) => clearTimeout(timeoutId));
      currentTimeoutRefs.clear();
    };
  }, []);

  /**
   * dismissToast - Removes a toast notification by ID
   * Also clears any active timeout for the toast
   *
   * @param id - Unique identifier of the toast to dismiss
   */
  const dismissToast = useCallback((id: string) => {
    setToasts((prevToasts) => prevToasts.filter((toast) => toast.id !== id));

    // Clear timeout if it exists
    const timeoutId = timeoutRefs.current.get(id);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutRefs.current.delete(id);
    }
  }, []);

  /**
   * showToast - Displays a new toast notification
   * Automatically assigns a unique ID and sets up auto-dismiss timer
   * Limits the number of visible toasts to MAX_TOASTS
   *
   * @param options - Toast configuration options (variant, title, message, duration, dismissible)
   */
  const showToast = useCallback(
    (options: ToastOptions) => {
      // Generate unique ID using timestamp + random string
      const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // Create toast object with defaults
      const newToast: Toast = {
        id,
        variant: options.variant,
        title: options.title,
        message: options.message,
        duration: options.duration ?? TOAST_DEFAULTS.DURATION,
        dismissible: options.dismissible ?? TOAST_DEFAULTS.DISMISSIBLE,
        onClick: options.onClick,
      };

      // Add new toast and enforce max limit
      setToasts((prevToasts) => {
        const updatedToasts = [...prevToasts, newToast];

        // If we exceed the maximum, remove the oldest toast(s)
        if (updatedToasts.length > TOAST_DEFAULTS.MAX_TOASTS) {
          return updatedToasts.slice(-TOAST_DEFAULTS.MAX_TOASTS);
        }

        return updatedToasts;
      });

      // Set up auto-dismiss timer if duration is specified
      if (newToast.duration && newToast.duration > 0) {
        const timeoutId = setTimeout(() => {
          dismissToast(id);
        }, newToast.duration);

        // Store timeout ID for cleanup
        timeoutRefs.current.set(id, timeoutId);
      }
    },
    [dismissToast],
  );

  /**
   * clearAllToasts - Removes all active toast notifications
   * Also clears all active timeouts
   * Useful for cleanup or reset scenarios
   */
  const clearAllToasts = useCallback(() => {
    setToasts([]);

    // Clear all timeouts
    timeoutRefs.current.forEach((timeoutId) => clearTimeout(timeoutId));
    timeoutRefs.current.clear();
  }, []);

  const value: ToastContextValue = {
    toasts,
    showToast,
    dismissToast,
    clearAllToasts,
  };

  return (
    <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
  );
}

/**
 * useToast - Custom hook for accessing toast context
 * Throws an error if used outside of ToastProvider
 *
 * @returns ToastContextValue with toasts array and control functions
 * @throws Error if used outside of ToastProvider
 */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);

  if (context === undefined) {
    throw new Error('useToast must be used within a ToastProvider');
  }

  return context;
}
