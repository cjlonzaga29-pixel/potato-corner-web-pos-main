'use client';

import { Loader2, MapPin } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface LocationAccessRecoveryProps {
  message: string;
  isRetrying: boolean;
  onRetry: () => void;
  /** Only the confirmed-blocked-permission case gets the "How to Enable Location" help — a GPS-off or timeout error doesn't need browser-settings instructions. */
  showHelp: boolean;
}

/**
 * Cashier-facing recovery panel shown in place of a raw geolocation error
 * (e.g. "User denied Geolocation"). Kept as one small reusable block so both
 * the standalone Clock In page and the POS Terminal's Clock In gate render
 * identical recovery UX instead of duplicating instructions inline.
 */
export function LocationAccessRecovery({ message, isRetrying, onRetry, showHelp }: LocationAccessRecoveryProps) {
  return (
    <div className="space-y-2">
      <Alert variant="destructive">
        <MapPin className="h-4 w-4" />
        <AlertTitle>Location access required</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
      <div className="flex gap-2">
        <Button className="flex-1 touch-target" onClick={onRetry} disabled={isRetrying}>
          {isRetrying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Try Again
        </Button>
        {showHelp && (
          <Popover>
            <PopoverTrigger asChild>
              <Button className="flex-1 touch-target" variant="outline" type="button">
                How to Enable Location
              </Button>
            </PopoverTrigger>
            <PopoverContent className="space-y-3 text-sm" align="center">
              <div>
                <p className="font-medium">Chrome / Brave (Android)</p>
                <p className="text-muted-foreground">Site settings → Location → Allow</p>
              </div>
              <div>
                <p className="font-medium">Android system settings</p>
                <p className="text-muted-foreground">Settings → Apps → your browser → Permissions → Location → Allow while using the app</p>
              </div>
              <p className="text-muted-foreground">Then return here and tap Try Again.</p>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
}
