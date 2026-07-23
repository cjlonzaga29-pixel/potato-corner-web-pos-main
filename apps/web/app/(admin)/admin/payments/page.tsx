'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const PAYMENT_METHODS = [
  {
    id: 'gcash-qr',
    label: 'GCash QR',
    description: 'Manage GCash QR codes assigned to branches.',
    href: '/admin/payments/gcash-qr',
  },
  {
    id: 'maya-qr',
    label: 'Maya / PayMaya QR',
    description: 'Maya payment QR setup will be available soon.',
    href: '/admin/payments/maya-qr',
    comingSoon: true,
  },
];

export default function PaymentSettingsPage() {
  const [expandedId, setExpandedId] = useState<string | null>(PAYMENT_METHODS[0]?.id ?? null);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Payment Settings</h1>
        <p className="text-sm text-muted-foreground">Configure payment methods available across branches.</p>
      </div>

      <div className="space-y-3">
        {PAYMENT_METHODS.map((method) => {
          const isExpanded = expandedId === method.id;
          return (
            <Card key={method.id}>
              <CardHeader
                className="cursor-pointer select-none"
                onClick={() => setExpandedId(isExpanded ? null : method.id)}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Wallet className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        {method.label}
                        {method.comingSoon && <Badge variant="secondary">Coming Soon</Badge>}
                      </CardTitle>
                      <CardDescription>{method.description}</CardDescription>
                    </div>
                  </div>
                  <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', isExpanded && 'rotate-180')} />
                </div>
              </CardHeader>
              {isExpanded && (
                <CardContent>
                  <Button asChild size="sm">
                    <Link href={method.href}>Manage {method.label}</Link>
                  </Button>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
