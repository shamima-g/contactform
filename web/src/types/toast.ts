/**
 * Toast notification type definitions
 * Defines interfaces for the toast notification system
 */

/**
 * ToastVariant - Available toast notification variants
 */
export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

/**
 * Toast - Individual toast notification object
 */
export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  message?: string;
  duration?: number; // Duration in milliseconds (default: 5000)
  dismissible?: boolean; // Whether user can manually dismiss (default: true)
  onClick?: () => void; // Optional click handler for interactive toasts
}

/**
 * ToastOptions - Options for creating a new toast
 * Used when calling showToast function
 */
export interface ToastOptions {
  variant: ToastVariant;
  title: string;
  message?: string;
  duration?: number;
  dismissible?: boolean;
  onClick?: () => void;
}

/**
 * ToastContextValue - Context value for toast provider
 * Provides toast state and functions to child components
 */
export interface ToastContextValue {
  toasts: Toast[];
  showToast: (options: ToastOptions) => void;
  dismissToast: (id: string) => void;
  clearAllToasts: () => void;
}

/**
 * ToastProps - Props for individual Toast component
 */
export interface ToastProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

/**
 * ToastContainerProps - Props for ToastContainer component
 * Optional position configuration for future enhancement
 */
export interface ToastContainerProps {
  position?:
    | 'top-right'
    | 'top-left'
    | 'bottom-right'
    | 'bottom-left'
    | 'top-center'
    | 'bottom-center';
  maxToasts?: number; // Maximum number of toasts to display at once (default: 3)
}

/**
 * Default toast configuration values
 */
export const TOAST_DEFAULTS = {
  DURATION: 5000, // 5 seconds
  MAX_TOASTS: 3,
  POSITION: 'top-right' as const,
  DISMISSIBLE: true,
} as const;

/**
 * Toast variant configuration
 * Maps variants to their visual properties
 */
export const TOAST_VARIANT_CONFIG = {
  success: {
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
    textColor: 'text-green-900',
    iconColor: 'text-green-600',
  },
  error: {
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    textColor: 'text-red-900',
    iconColor: 'text-red-600',
  },
  info: {
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    textColor: 'text-blue-900',
    iconColor: 'text-blue-600',
  },
  warning: {
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
    textColor: 'text-amber-900',
    iconColor: 'text-amber-600',
  },
} as const;
