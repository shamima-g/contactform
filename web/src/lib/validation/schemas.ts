/**
 * Common Validation Schemas
 *
 * Zod schemas for validating user input across the application.
 * Provides type-safe validation with detailed error messages.
 */

import { z } from 'zod';

/**
 * Email validation schema
 * Validates email format and normalizes to lowercase
 */
export const emailSchema = z
  .string()
  .email('Invalid email address')
  .toLowerCase()
  .trim();

/**
 * Password validation schema
 * Requires minimum 8 characters with at least:
 * - One uppercase letter
 * - One lowercase letter
 * - One number
 * - One special character
 */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(
    /[^A-Za-z0-9]/,
    'Password must contain at least one special character',
  );

/**
 * Relaxed password schema for optional/less strict use cases
 * Only requires minimum length
 */
export const simplePasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters');

/**
 * User ID validation schema
 * Validates MongoDB ObjectId or UUID format
 */
export const userIdSchema = z
  .string()
  .regex(
    /^[a-f\d]{24}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'Invalid user ID format',
  );

/**
 * File upload validation schema
 * Validates file type and size
 */
export const fileUploadSchema = z.object({
  name: z.string().min(1, 'File name is required'),
  size: z.number().max(5 * 1024 * 1024, 'File size must be less than 5MB'), // 5MB limit
  type: z
    .string()
    .regex(
      /^(image\/(jpeg|png|gif|webp)|application\/pdf)$/,
      'File type must be JPEG, PNG, GIF, WebP, or PDF',
    ),
});

/**
 * Pagination schema
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
});

/**
 * Search query schema
 */
export const searchSchema = z.object({
  q: z.string().min(1, 'Search query is required').max(200).trim(),
  filters: z.record(z.string(), z.string()).optional(),
});

/**
 * Generic form field validation
 */
export const formFieldSchemas = {
  name: z.string().min(1, 'Name is required').max(100).trim(),
  description: z.string().max(500).optional(),
  url: z.string().url('Invalid URL format').optional().or(z.literal('')),
  phoneNumber: z
    .string()
    .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number format')
    .optional()
    .or(z.literal('')),
  dateString: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format'),
};

/**
 * Type-safe validation helper
 * Validates data against a schema and returns typed result
 *
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Validation result with success flag, data, and errors
 *
 * @example
 * ```ts
 * const result = validateRequest(paginationSchema, { page: '2', limit: '20' });
 * if (result.success) {
 *   // result.data is typed as { page: number, limit: number }
 *   console.log(result.data.page);
 * } else {
 *   console.error(result.errors);
 * }
 * ```
 */
export function validateRequest<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): { success: true; data: z.infer<T> } | { success: false; errors: string[] } {
  const result = schema.safeParse(data);

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }

  return {
    success: false,
    errors: result.error.issues.map((err: z.ZodIssue) => {
      const path = err.path.join('.');
      return path ? `${path}: ${err.message}` : err.message;
    }),
  };
}

/**
 * Async version of validateRequest for schemas with async refinements
 */
export async function validateRequestAsync<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): Promise<
  { success: true; data: z.infer<T> } | { success: false; errors: string[] }
> {
  const result = await schema.safeParseAsync(data);

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }

  return {
    success: false,
    errors: result.error.issues.map((err: z.ZodIssue) => {
      const path = err.path.join('.');
      return path ? `${path}: ${err.message}` : err.message;
    }),
  };
}

/**
 * Sanitize HTML input to prevent XSS attacks
 * Strips HTML tags and dangerous characters
 */
export function sanitizeHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/[<>'"]/g, '') // Remove dangerous characters
    .trim();
}

/**
 * Create a schema with sanitization
 * Useful for text inputs that should not contain HTML
 */
export const sanitizedStringSchema = z.string().transform(sanitizeHtml);
