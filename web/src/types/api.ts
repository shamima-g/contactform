/**
 * API Type Definitions Template
 *
 * Generic type definitions for API communication
 * Customize these based on your API's response format
 */

/**
 * DefaultResponse - Standard API response structure
 * Customize this based on your API's response format
 * Common in REST APIs for mutation endpoints (POST, PUT, DELETE)
 */
export interface DefaultResponse {
  Id: number;
  MessageType: string;
  Messages: string[];
}

/**
 * APIError - Standardized error object for API failures
 * Used throughout the application for consistent error handling
 */
export interface APIError {
  message: string;
  statusCode?: number;
  details?: string[];
  endpoint?: string;
}

export type QueryParamScalar = string | number | boolean;
export type QueryParams = Record<
  string,
  QueryParamScalar | ReadonlyArray<QueryParamScalar> | undefined
>;

/**
 * APIRequestConfig - Configuration options for API requests
 * Extends standard fetch RequestInit with additional options
 */
export interface APIRequestConfig extends RequestInit {
  params?: QueryParams;
  /**
   * When true, the client injects an auth header from getAuthHeader() (env-var
   * driven, populated by api-connectivity-agent during INTAKE Step 4b). Caller-
   * supplied headers always win — set headers explicitly to override.
   */
  requiresAuth?: boolean;
  lastChangedUser?: string; // For audit trails - remove if not needed
  isBinaryResponse?: boolean; // Flag to indicate response should be treated as binary data
}

/**
 * APIResponse - Generic wrapper for successful API responses
 * Provides type-safe response handling
 */
export interface APIResponse<T> {
  data: T;
  status: number;
  statusText: string;
}

/**
 * API Message Type enum values
 * Customize based on your API's message types
 */
export const APIMessageType = {
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
  WARNING: 'WARNING',
  INFO: 'INFO',
} as const;

export type APIMessageTypeValue =
  (typeof APIMessageType)[keyof typeof APIMessageType];

/**
 * HTTP Status Codes - Common status codes used in the application
 */
export const HTTPStatus = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500,
} as const;

export type HTTPStatusCode = (typeof HTTPStatus)[keyof typeof HTTPStatus];
