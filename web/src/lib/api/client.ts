/**
 * Base API Client Template
 *
 * A reusable fetch wrapper providing:
 * - Error handling for common HTTP status codes
 * - Automatic JSON parsing
 * - Request/response logging for development
 * - Type-safe API responses
 *
 * USAGE:
 * 1. Update API_BASE_URL in constants.ts or environment variables
 * 2. Define your API endpoints as functions that call apiClient
 * 3. Customize error handling and logging as needed
 */

import { API_BASE_URL } from '@/lib/utils/constants';
import type {
  APIError,
  APIRequestConfig,
  DefaultResponse,
  HTTPStatusCode,
  QueryParams,
} from '@/types/api';

/**
 * Main API client function that wraps fetch with error handling and logging
 *
 * @param endpoint - API endpoint path (e.g., '/v1/resource')
 * @param config - Request configuration including method, body, headers, etc.
 * @returns Promise with parsed JSON response
 * @throws APIError on HTTP errors or network failures
 */
export async function apiClient<T = unknown>(
  endpoint: string,
  config: APIRequestConfig = {},
): Promise<T> {
  const {
    params,
    lastChangedUser,
    isBinaryResponse,
    requiresAuth,
    ...fetchConfig
  } = config;

  // Build full URL with query parameters
  const url = buildUrl(endpoint, params);

  // Build headers
  const headers = buildHeaders(
    fetchConfig.method,
    lastChangedUser,
    fetchConfig.headers,
    fetchConfig.body ?? undefined,
    requiresAuth,
  );

  // Log request in development
  logRequest(url, fetchConfig.method || 'GET', fetchConfig.body ?? undefined);

  try {
    const response = await fetch(url, {
      ...fetchConfig,
      headers,
      body: fetchConfig.body ?? undefined,
    });

    // Log response in development
    logResponse(response);

    // Handle specific error status codes
    if (!response.ok) {
      await handleErrorResponse(response, url);
    }

    // Handle successful responses
    return await handleSuccessResponse<T>(response, isBinaryResponse);
  } catch (error) {
    // Handle network errors or other unexpected errors
    if (error instanceof Error && error.name === 'TypeError') {
      throw createAPIError(
        'Network error: Unable to connect to the API server',
        0,
        ['Please check your internet connection and try again.'],
        url,
      );
    }

    // Re-throw API errors
    throw error;
  }
}

/**
 * Builds the full URL with query parameters.
 *
 * Array values serialize as repeated params (`['a','b']` → `?k=a&k=b`); for
 * `explode: false` APIs, join at the endpoint-function layer. Empty arrays and
 * `undefined` values drop the key entirely (the "clear all filters" path). An
 * explicit empty string IS sent for scalars (`?k=`) — caller chose that. Array
 * items that are empty strings are dropped, since an array of empty strings is
 * never a meaningful filter selection.
 */
function buildUrl(endpoint: string, params?: QueryParams): string {
  const baseUrl = `${API_BASE_URL}${endpoint}`;

  if (!params) {
    return baseUrl;
  }

  const queryParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== '') {
          queryParams.append(key, String(item));
        }
      });
      return;
    }
    queryParams.append(key, String(value));
  });

  const queryString = queryParams.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}

/**
 * Builds request headers
 * Only sets Content-Type when there's a request body
 * Injects auth header from getAuthHeader() when requiresAuth is true and an
 * explicit override isn't already present in customHeaders
 */
function buildHeaders(
  method?: string,
  lastChangedUser?: string,
  customHeaders?: HeadersInit,
  body?: BodyInit,
  requiresAuth?: boolean,
): Record<string, string> {
  const baseHeaders: Record<string, string> = {};

  // Convert HeadersInit to plain object if needed
  if (customHeaders) {
    if (customHeaders instanceof Headers) {
      customHeaders.forEach((value, key) => {
        baseHeaders[key] = value;
      });
    } else if (Array.isArray(customHeaders)) {
      customHeaders.forEach(([key, value]) => {
        baseHeaders[key] = value;
      });
    } else {
      Object.assign(baseHeaders, customHeaders);
    }
  }

  // Only set Content-Type for requests with a body
  const hasBody = body !== undefined;
  const methodsWithBody = ['POST', 'PUT', 'PATCH'];
  const shouldSetContentType =
    hasBody || (method && methodsWithBody.includes(method.toUpperCase()));

  if (shouldSetContentType && !baseHeaders['Content-Type']) {
    baseHeaders['Content-Type'] = 'application/json';
  }

  // Add custom headers (e.g., LastChangedUser for audit trails)
  if (lastChangedUser) {
    baseHeaders['LastChangedUser'] = lastChangedUser;
  }

  // Inject auth header when the caller asked for it and the header is configured
  // via env vars captured during INTAKE Step 4b. Caller-provided headers win.
  if (requiresAuth) {
    const authHeader = getAuthHeader();
    if (authHeader && !(authHeader.name in baseHeaders)) {
      baseHeaders[authHeader.name] = authHeader.value;
    }
  }

  return baseHeaders;
}

/**
 * Reads auth-header configuration from env vars captured by api-connectivity-agent
 * during INTAKE Step 4b. Returns null when no token is configured (the request
 * proceeds without an Authorization header — useful in mock mode and on public
 * endpoints).
 *
 * Env var contract:
 * - NEXT_PUBLIC_API_AUTH_HEADER (default: "Authorization")
 * - NEXT_PUBLIC_API_AUTH_VALUE_PREFIX (default: "Bearer ", trailing space optional)
 * - NEXT_PUBLIC_API_TOKEN (the credential value)
 *
 * NEXT_PUBLIC_* vars are baked into the browser bundle. For production apps that
 * call a real backend with sensitive tokens, prefer a BFF or Next.js API route
 * proxy so tokens stay server-side. This helper is intended for local dev against
 * a dev backend where the convenience outweighs the exposure.
 */
export function getAuthHeader(): { name: string; value: string } | null {
  const token = process.env.NEXT_PUBLIC_API_TOKEN;
  if (!token) return null;

  const name = process.env.NEXT_PUBLIC_API_AUTH_HEADER || 'Authorization';
  const rawPrefix = process.env.NEXT_PUBLIC_API_AUTH_VALUE_PREFIX;
  const prefix =
    rawPrefix === undefined
      ? 'Bearer '
      : rawPrefix.length > 0 && !rawPrefix.endsWith(' ')
        ? `${rawPrefix} `
        : rawPrefix;

  return { name, value: `${prefix}${token}` };
}

/**
 * Handles error responses from the API
 * Customize this function based on your API's error response format
 */
async function handleErrorResponse(
  response: Response,
  url: string,
): Promise<never> {
  const statusCode = response.status as HTTPStatusCode;

  // Try to extract error details from response body
  let errorMessages: string[] = [];
  let defaultMessage = `HTTP ${statusCode}: ${response.statusText}`;

  try {
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const errorData = (await response.json()) as DefaultResponse;

      if (errorData.Messages && errorData.Messages.length > 0) {
        errorMessages = errorData.Messages;
        defaultMessage = errorMessages[0];
      } else if (errorData.MessageType) {
        defaultMessage = `${errorData.MessageType}: ${defaultMessage}`;
      }
    }
  } catch {
    // If parsing fails, use default error message
  }

  // Handle specific status codes
  // Customize these messages based on your application's needs
  switch (statusCode) {
    case 401:
      throw createAPIError(
        'Unauthorized: Please log in to continue',
        statusCode,
        errorMessages.length > 0
          ? errorMessages
          : ['Your session may have expired. Please log in again.'],
        url,
      );

    case 403:
      throw createAPIError(
        'Forbidden: You do not have permission to perform this action',
        statusCode,
        errorMessages.length > 0 ? errorMessages : ['Access denied.'],
        url,
      );

    case 404:
      throw createAPIError(
        'Not Found: The requested resource does not exist',
        statusCode,
        errorMessages.length > 0 ? errorMessages : ['Resource not found.'],
        url,
      );

    case 500:
      throw createAPIError(
        'Internal Server Error: Something went wrong on the server',
        statusCode,
        errorMessages.length > 0
          ? errorMessages
          : [
              'Please try again later or contact support if the problem persists.',
            ],
        url,
      );

    default:
      throw createAPIError(
        defaultMessage,
        statusCode,
        errorMessages.length > 0
          ? errorMessages
          : [`Request failed with status ${statusCode}`],
        url,
      );
  }
}

/**
 * Handles successful API responses
 * Parses JSON or returns void for 204 No Content responses
 * For binary responses, returns a Blob
 */
async function handleSuccessResponse<T>(
  response: Response,
  isBinaryResponse?: boolean,
): Promise<T> {
  // Handle 204 No Content responses (e.g., DELETE operations)
  if (response.status === 204) {
    return undefined as T;
  }

  // If explicitly marked as binary response, always return blob
  if (isBinaryResponse) {
    return (await response.blob()) as T;
  }

  const contentType = response.headers.get('content-type');

  // Handle JSON responses
  if (contentType && contentType.includes('application/json')) {
    return (await response.json()) as T;
  }

  // Handle binary responses (e.g., file downloads)
  if (contentType && contentType.includes('application/octet-stream')) {
    return (await response.blob()) as T;
  }

  // Fallback: try to parse as JSON
  try {
    return (await response.json()) as T;
  } catch {
    // If JSON parsing fails, return undefined
    return undefined as T;
  }
}

/**
 * Creates a standardized APIError object
 */
function createAPIError(
  message: string,
  statusCode: number,
  details: string[],
  endpoint: string,
): APIError {
  return {
    message,
    statusCode,
    details,
    endpoint,
  };
}

/**
 * Sanitizes request body for safe logging by removing sensitive fields
 * Customize the sensitiveFields array based on your application's needs
 */
function sanitizeBodyForLogging(body: BodyInit | null): unknown {
  if (!body) {
    return null;
  }

  try {
    const parsed = JSON.parse(body as string);
    const sensitiveFields = [
      'password',
      'token',
      'apiKey',
      'secret',
      'creditCard',
      'ssn',
    ];

    // Create a sanitized copy
    const sanitized = { ...parsed };

    // Remove or mask sensitive fields
    Object.keys(sanitized).forEach((key) => {
      if (sensitiveFields.some((field) => key.toLowerCase().includes(field))) {
        sanitized[key] = '***REDACTED***';
      }
    });

    return sanitized;
  } catch {
    return '[Unable to parse body]';
  }
}

/**
 * Logs API request details in development mode
 * Automatically sanitizes sensitive fields for security
 */
function logRequest(url: string, method: string, body?: BodyInit | null): void {
  if (process.env.NODE_ENV === 'development') {
    console.group(`API Request: ${method} ${url}`);
    console.log('URL:', url);
    console.log('Method:', method);

    if (body) {
      console.log('Body:', sanitizeBodyForLogging(body));
    }

    console.groupEnd();
  }
}

/**
 * Logs API response details in development mode
 */
function logResponse(response: Response): void {
  if (process.env.NODE_ENV === 'development') {
    const statusEmoji = response.ok ? '✅' : '❌';
    console.log(
      `${statusEmoji} API Response: ${response.status} ${response.statusText}`,
    );
  }
}

interface ClientCallOptions {
  requiresAuth?: boolean;
}

/**
 * Convenience method for GET requests
 */
export async function get<T>(
  endpoint: string,
  params?: QueryParams,
  options?: ClientCallOptions,
): Promise<T> {
  return apiClient<T>(endpoint, {
    method: 'GET',
    params,
    requiresAuth: options?.requiresAuth,
  });
}

/**
 * Convenience method for POST requests
 */
export async function post<T>(
  endpoint: string,
  body?: unknown,
  lastChangedUser?: string,
  options?: ClientCallOptions,
): Promise<T> {
  return apiClient<T>(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
    lastChangedUser,
    requiresAuth: options?.requiresAuth,
  });
}

/**
 * Convenience method for PUT requests
 */
export async function put<T>(
  endpoint: string,
  body?: unknown,
  lastChangedUser?: string,
  options?: ClientCallOptions,
): Promise<T> {
  return apiClient<T>(endpoint, {
    method: 'PUT',
    body: JSON.stringify(body),
    lastChangedUser,
    requiresAuth: options?.requiresAuth,
  });
}

/**
 * Convenience method for DELETE requests
 */
export async function del<T>(
  endpoint: string,
  lastChangedUser?: string,
  options?: ClientCallOptions,
): Promise<T> {
  return apiClient<T>(endpoint, {
    method: 'DELETE',
    lastChangedUser,
    requiresAuth: options?.requiresAuth,
  });
}
