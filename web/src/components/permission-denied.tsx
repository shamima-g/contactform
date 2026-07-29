import { ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * On-page banner shown when a signed-in user opens a route their role can't
 * access. Deliberately not an error page or a redirect — the user stays on the
 * URL and sees why they can't proceed.
 */
export function PermissionDenied() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <Alert variant="destructive" role="alert">
        <ShieldAlert className="h-5 w-5" />
        <AlertTitle>
          You don&apos;t have permission to view this page
        </AlertTitle>
        <AlertDescription>
          Your account role doesn&apos;t have access to this area. Use the
          navigation to return to a page you can view.
        </AlertDescription>
      </Alert>
    </div>
  );
}
