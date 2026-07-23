import { Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function MayaQrPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Maya / PayMaya QR</h1>
        <p className="text-sm text-muted-foreground">Maya payment QR setup will be available soon.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Wallet className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                Maya / PayMaya QR
                <Badge variant="secondary">Coming Soon</Badge>
              </CardTitle>
              <CardDescription>Maya payment QR setup will be available soon.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">This feature is under development.</p>
        </CardContent>
      </Card>
    </div>
  );
}
