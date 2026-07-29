'use client';

import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CATEGORIES } from '@/types/domain';
import type { Enquiry } from '@/types/domain';
import {
  enquiryFormSchema,
  type EnquiryFormValues,
} from '@/lib/validation/enquiry';
import { createEnquiry } from '@/lib/api/enquiries';
import { useSession } from '@/lib/auth/session';

const DEFAULTS: EnquiryFormValues = {
  name: '',
  email: '',
  address: '',
  category: 'Question',
  comment: '',
};

export function ContactForm() {
  const { user } = useSession();
  const [confirmation, setConfirmation] = useState<Enquiry | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EnquiryFormValues>({
    resolver: zodResolver(enquiryFormSchema),
    defaultValues: DEFAULTS,
  });

  const onSubmit = async (values: EnquiryFormValues) => {
    setSubmitError(null);
    try {
      const created = await createEnquiry(
        {
          name: values.name,
          email: values.email,
          address: values.address ?? null,
          category: values.category,
          comment: values.comment,
        },
        user?.email ?? values.email,
      );
      setConfirmation(created);
      reset(DEFAULTS);
    } catch {
      setSubmitError(
        'Something went wrong sending your message. Please try again.',
      );
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Contact us</h1>
        <p className="text-muted-foreground">
          Send us your feedback, a question, or a general enquiry.
        </p>
      </div>

      {confirmation && (
        <Alert role="status">
          <CheckCircle2 className="h-5 w-5" />
          <AlertTitle>Message sent!</AlertTitle>
          <AlertDescription>
            <p>
              Thanks — we&apos;ve received your enquiry. Here&apos;s what you
              sent:
            </p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="font-medium">Name</dt>
              <dd>{confirmation.name}</dd>
              <dt className="font-medium">Email</dt>
              <dd>{confirmation.email}</dd>
              {confirmation.address && (
                <>
                  <dt className="font-medium">Address</dt>
                  <dd>{confirmation.address}</dd>
                </>
              )}
              <dt className="font-medium">Category</dt>
              <dd>{confirmation.category}</dd>
              <dt className="font-medium">Comment</dt>
              <dd>{confirmation.comment}</dd>
            </dl>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Your enquiry</CardTitle>
          <CardDescription>Fields marked * are required.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="space-y-4"
            noValidate
          >
            {submitError && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                {...register('name')}
                aria-invalid={!!errors.name}
              />
              {errors.name && (
                <p className="text-sm text-destructive">
                  {errors.name.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                {...register('email')}
                aria-invalid={!!errors.email}
              />
              {errors.email && (
                <p className="text-sm text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="address">Address</Label>
              <Input id="address" {...register('address')} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">Category *</Label>
              <Controller
                control={control}
                name="category"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="category" aria-label="Category">
                      <SelectValue placeholder="Choose a category" />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((category) => (
                        <SelectItem key={category} value={category}>
                          {category}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.category && (
                <p className="text-sm text-destructive">
                  {errors.category.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="comment">Comment *</Label>
              <Textarea
                id="comment"
                rows={4}
                {...register('comment')}
                aria-invalid={!!errors.comment}
              />
              {errors.comment && (
                <p className="text-sm text-destructive">
                  {errors.comment.message}
                </p>
              )}
            </div>

            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Sending…' : 'Send message'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
