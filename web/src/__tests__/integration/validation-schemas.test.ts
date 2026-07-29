/**
 * Integration Test: Validation & Sanitization
 *
 * IMPORTANT: This file tests SECURITY-CRITICAL functionality only.
 *
 * Testing Philosophy:
 * - DO test security functions (sanitizeHtml, XSS prevention) directly
 * - DO NOT test Zod schema validation rules directly
 * - Validation rules (email format, password strength) should be tested
 *   through integration tests with actual form components
 *
 * When you build forms in your project, test validation like this:
 *
 * ```typescript
 * // GOOD: Test validation through user interaction
 * it('shows error when password is too weak', async () => {
 *   render(<SignUpForm />);
 *   await user.type(screen.getByLabelText('Password'), 'weak');
 *   await user.click(screen.getByRole('button', { name: 'Sign Up' }));
 *   expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();
 * });
 *
 * // BAD: Test schema directly
 * it('should reject weak passwords', () => {
 *   expect(passwordSchema.safeParse('weak').success).toBe(false);
 * });
 * ```
 *
 * The "good" test verifies user experience. The "bad" test only verifies Zod works.
 */

import { sanitizeHtml, validateRequest } from '@/lib/validation/schemas';
import { z } from 'zod';

describe('Security: XSS Sanitization', () => {
  describe('sanitizeHtml', () => {
    it('removes script tags to prevent XSS', () => {
      const malicious = '<script>alert("xss")</script>';
      const sanitized = sanitizeHtml(malicious);
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).not.toContain('</script>');
    });

    it('neutralises attribute-based XSS vectors, not just literal <script>', () => {
      // The whole <img ...> tag is stripped to nothing. A sanitiser that
      // removed only literal <script> would leave this intact and fail here.
      expect(sanitizeHtml('<img src=x onerror="alert(\'xss\')">')).toBe('');
    });

    it('removes HTML tags while preserving text content', () => {
      expect(sanitizeHtml('Hello <b>World</b>')).toBe('Hello World');
      expect(sanitizeHtml('<div>Content</div>')).toBe('Content');
    });

    it('removes dangerous characters used in XSS attacks', () => {
      // Characters that could be used to break out of attributes or inject code
      expect(sanitizeHtml('test<>"\'')).toBe('test');
    });

    it('preserves safe text without modification', () => {
      expect(sanitizeHtml('Plain text')).toBe('Plain text');
      expect(sanitizeHtml('Hello, World!')).toBe('Hello, World!');
      expect(sanitizeHtml('Price: $100 (discounted)')).toBe(
        'Price: $100 (discounted)',
      );
    });

    it('trims whitespace', () => {
      expect(sanitizeHtml('  text  ')).toBe('text');
    });
  });
});

describe('Validation Helper: validateRequest', () => {
  // Testing the helper function itself, not Zod behavior
  const testSchema = z.object({
    name: z.string().min(1),
    age: z.number().positive(),
  });

  it('returns success with typed data for valid input', () => {
    const result = validateRequest(testSchema, { name: 'John', age: 30 });

    expect(result.success).toBe(true);
    if (result.success) {
      // Type safety: result.data should be typed
      expect(result.data.name).toBe('John');
      expect(result.data.age).toBe(30);
    }
  });

  it('returns errors array for invalid input', () => {
    const result = validateRequest(testSchema, { name: '', age: -5 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
      // Errors should be human-readable strings
      expect(result.errors.every((e) => typeof e === 'string')).toBe(true);
    }
  });

  it('includes field path in error messages', () => {
    const result = validateRequest(testSchema, { name: '', age: 30 });

    expect(result.success).toBe(false);
    if (!result.success) {
      // Should indicate which field failed
      expect(result.errors.some((e) => e.includes('name'))).toBe(true);
    }
  });
});

/**
 * NOTE: The validation schemas (emailSchema, passwordSchema, etc.) are NOT
 * tested directly here. They should be tested through integration tests
 * when you build forms that use them.
 *
 * Example integration test for a sign-up form:
 *
 * describe('SignUpForm validation', () => {
 *   it('shows password requirements when password is too weak', async () => {
 *     render(<SignUpForm />);
 *     await user.type(screen.getByLabelText('Password'), 'weak');
 *     await user.click(screen.getByRole('button', { name: 'Create Account' }));
 *
 *     expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
 *   });
 *
 *   it('shows error when passwords do not match', async () => {
 *     render(<SignUpForm />);
 *     await user.type(screen.getByLabelText('Password'), 'StrongPass1!');
 *     await user.type(screen.getByLabelText('Confirm Password'), 'Different1!');
 *     await user.click(screen.getByRole('button', { name: 'Create Account' }));
 *
 *     expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
 *   });
 * });
 */
