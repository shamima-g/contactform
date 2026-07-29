/**
 * Zod schemas for enquiry-related forms. Drives inline validation on the
 * contact form and the resolve-with-note dialog.
 */
import { z } from 'zod';
import { CATEGORIES } from '@/types/domain';

export const enquiryFormSchema = z.object({
  name: z.string().trim().min(1, 'Please enter your name'),
  email: z
    .string()
    .trim()
    .min(1, 'Please enter your email')
    .email('Please enter a valid email address'),
  address: z.string().trim().optional(),
  category: z.enum(CATEGORIES, {
    errorMap: () => ({ message: 'Please choose a category' }),
  }),
  comment: z.string().trim().min(1, 'Please enter a comment'),
});

export type EnquiryFormValues = z.infer<typeof enquiryFormSchema>;

export const replyNoteSchema = z.object({
  replyNote: z.string().trim().min(1, 'A reply note is required to resolve'),
});

export type ReplyNoteValues = z.infer<typeof replyNoteSchema>;
