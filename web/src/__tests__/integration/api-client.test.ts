/**
 * Integration Test: API Client
 *
 * This template demonstrates best practices for integration testing
 * in this project. Integration tests verify that multiple units work
 * together correctly, such as API clients, data fetching, and error handling.
 *
 * Best practices for integration tests:
 * - Test realistic user workflows end-to-end
 * - Mock external dependencies (actual API calls)
 * - Verify data flows through multiple layers
 * - Test error scenarios and edge cases
 * - Use descriptive test names that describe the scenario
 */

import { vi, type Mock } from 'vitest';
import { apiClient, get, post } from '@/lib/api/client';
import type { APIError } from '@/types/api';

// Mock the global fetch function
global.fetch = vi.fn();

describe('API Client Integration Tests', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
  });

  describe('Successful API requests', () => {
    it('should fetch data and parse JSON response', async () => {
      // Arrange
      const mockData = { id: 1, name: 'Test User' };
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => mockData,
      });

      // Act
      const result = await apiClient<typeof mockData>('/v1/users/1', {
        method: 'GET',
      });

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/users/1'),
        expect.objectContaining({
          method: 'GET',
        }),
      );
      expect(result).toEqual(mockData);
    });

    it('should send POST request with body using convenience method', async () => {
      // Arrange
      const requestBody = { name: 'New User', email: 'user@example.com' };
      const mockResponse = { id: 2, ...requestBody };
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => mockResponse,
      });

      // Act
      const result = await post<typeof mockResponse>(
        '/v1/users',
        requestBody,
        'TestUser',
      );

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/users'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(requestBody),
          headers: expect.objectContaining({
            LastChangedUser: 'TestUser',
          }),
        }),
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle query parameters', async () => {
      // Arrange
      const mockData = [{ id: 1, name: 'User 1' }];
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => mockData,
      });

      // Act
      await get<typeof mockData>('/v1/users', { role: 'admin', active: true });

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('role=admin'),
        expect.anything(),
      );
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('active=true'),
        expect.anything(),
      );
    });
  });

  describe('Error handling', () => {
    it('should handle 404 errors with proper error structure', async () => {
      // Arrange
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ Messages: ['User not found'] }),
      });

      // Act & Assert
      try {
        await apiClient('/v1/users/999', { method: 'GET' });
        throw new Error('Should have thrown an error');
      } catch (error) {
        const apiError = error as APIError;
        expect(apiError.statusCode).toBe(404);
        expect(apiError.message).toContain('Not Found');
        expect(apiError.details).toEqual(['User not found']);
      }
    });

    it('should handle 500 server errors', async () => {
      // Arrange
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({}),
      });

      // Act & Assert
      try {
        await apiClient('/v1/data', { method: 'GET' });
        throw new Error('Should have thrown an error');
      } catch (error) {
        const apiError = error as APIError;
        expect(apiError.statusCode).toBe(500);
        expect(apiError.message).toContain('Internal Server Error');
      }
    });

    it('should handle network errors', async () => {
      // Arrange
      (global.fetch as Mock).mockRejectedValueOnce(
        new TypeError('Failed to fetch'),
      );

      // Act & Assert
      try {
        await apiClient('/v1/users', { method: 'GET' });
        throw new Error('Should have thrown an error');
      } catch (error) {
        const apiError = error as APIError;
        expect(apiError.message).toContain('Network error');
        expect(apiError.statusCode).toBe(0);
      }
    });
  });

  describe('Request configuration', () => {
    it('should include LastChangedUser header for audit trails', async () => {
      // Arrange
      const mockData = { success: true };
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => mockData,
      });

      // Act
      await apiClient('/v1/data', {
        method: 'POST',
        body: JSON.stringify({ value: 'test' }),
        lastChangedUser: 'TestUser',
      });

      // Assert
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            LastChangedUser: 'TestUser',
          }),
        }),
      );
    });

    it('should handle 204 No Content responses', async () => {
      // Arrange
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers(),
      });

      // Act
      const result = await apiClient('/v1/users/1', { method: 'DELETE' });

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('requiresAuth flag', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('injects an Authorization header from env vars when requiresAuth is true', async () => {
      vi.stubEnv('NEXT_PUBLIC_API_TOKEN', 'test-token-abc');
      vi.stubEnv('NEXT_PUBLIC_API_AUTH_HEADER', 'Authorization');
      vi.stubEnv('NEXT_PUBLIC_API_AUTH_VALUE_PREFIX', 'Bearer');

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({}),
      });

      await apiClient('/v1/me', { method: 'GET', requiresAuth: true });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token-abc',
          }),
        }),
      );
    });

    it('does not set the Authorization header when requiresAuth is false', async () => {
      vi.stubEnv('NEXT_PUBLIC_API_TOKEN', 'test-token-abc');

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({}),
      });

      // A token IS configured — passing requiresAuth: false must still suppress
      // the header. This pins the explicit-false path the test name claims.
      await apiClient('/v1/public', { method: 'GET', requiresAuth: false });

      const call = (global.fetch as Mock).mock.calls[0];
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers?.Authorization).toBeUndefined();
    });

    it('does not set the Authorization header when no token is configured', async () => {
      vi.stubEnv('NEXT_PUBLIC_API_TOKEN', '');

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({}),
      });

      await apiClient('/v1/me', { method: 'GET', requiresAuth: true });

      const call = (global.fetch as Mock).mock.calls[0];
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers?.Authorization).toBeUndefined();
    });

    it('lets caller-supplied headers override the env-driven auth header', async () => {
      vi.stubEnv('NEXT_PUBLIC_API_TOKEN', 'env-token');

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({}),
      });

      await apiClient('/v1/me', {
        method: 'GET',
        requiresAuth: true,
        headers: { Authorization: 'Bearer caller-override' },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer caller-override',
          }),
        }),
      );
    });
  });
});
