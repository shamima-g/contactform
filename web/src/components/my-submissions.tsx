'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/status-badge';
import type { Enquiry } from '@/types/domain';
import { listMyEnquiries } from '@/lib/api/enquiries';
import { useSession } from '@/lib/auth/session';

/** A Visitor's read-only view of their own submitted enquiries (Story 3). */
export function MySubmissions() {
  const { user } = useSession();
  const email = user?.email;
  const [enquiries, setEnquiries] = useState<Enquiry[] | null>(null);

  useEffect(() => {
    if (!email) return;
    let active = true;
    listMyEnquiries(email).then((rows) => {
      if (active) setEnquiries(rows);
    });
    return () => {
      active = false;
    };
  }, [email]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">My submissions</h1>
        <p className="text-muted-foreground">
          The enquiries you&apos;ve submitted and their current status.
        </p>
      </div>

      {enquiries === null ? (
        <p className="text-muted-foreground" role="status">
          Loading…
        </p>
      ) : enquiries.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            You haven&apos;t submitted any enquiries yet. Head to{' '}
            <span className="font-medium text-foreground">Contact us</span> to
            send your first one.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-4">
          {enquiries.map((enquiry) => (
            <li key={enquiry.id}>
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
                  <CardTitle className="text-base">
                    {enquiry.category}
                  </CardTitle>
                  <StatusBadge status={enquiry.status} />
                </CardHeader>
                <CardContent className="space-y-2">
                  <p>{enquiry.comment}</p>
                  {enquiry.status === 'Resolved' && enquiry.replyNote && (
                    <p className="rounded-md bg-muted p-3 text-sm">
                      <span className="font-medium">Our reply: </span>
                      {enquiry.replyNote}
                    </p>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
