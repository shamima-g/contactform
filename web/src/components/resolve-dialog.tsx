'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { Enquiry } from '@/types/domain';

/**
 * Resolve-with-note dialog (Story 5). Requires a non-empty reply note before
 * confirming; an empty note shows a validation message and does not resolve.
 */
export function ResolveDialog({
  enquiry,
  open,
  onOpenChange,
  onConfirm,
}: {
  enquiry: Enquiry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (replyNote: string) => Promise<void>;
}) {
  // Reset per open via a remount key from the parent (keyed on enquiry id), so
  // there is no synchronous setState-in-effect to reset these.
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (note.trim().length === 0) {
      setError('A reply note is required to resolve this enquiry.');
      return;
    }
    setSubmitting(true);
    try {
      await onConfirm(note.trim());
      onOpenChange(false);
    } catch {
      setError('Something went wrong. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve enquiry</DialogTitle>
          <DialogDescription>
            {enquiry
              ? `Add a reply note for "${enquiry.name}" before resolving.`
              : 'Add a reply note before resolving.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reply-note">Reply note</Label>
          <Textarea
            id="reply-note"
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-invalid={!!error}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={submitting}>
            {submitting ? 'Resolving…' : 'Resolve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
