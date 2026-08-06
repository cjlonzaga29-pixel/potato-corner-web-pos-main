'use client';

import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useMigrationReport } from '@/hooks/queries/use-universal-inventory';

/**
 * CR-010 R6/R11 — read-only view of the CR-006 Phase B legacy-mapping dry
 * run (exact matches, ambiguous groups, duplicate/SKU/barcode collisions,
 * unmapped/invalid records). No migration or apply action exists here —
 * this report is advisory only, per R11's "no automatic migration".
 */
export default function MigrationReportPage() {
  const { data: report, isLoading, isError } = useMigrationReport(true);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !report) {
    return <p className="text-sm text-destructive">Failed to load the migration report.</p>;
  }

  const r = report as {
    generatedAt: string;
    migrationReadiness: boolean;
    blockers: string[];
    warnings: string[];
    sourceSummary: Record<string, number>;
    identityCandidates: unknown[];
    ambiguousGroups: unknown[];
    skuCollisions: unknown[];
    barcodeCollisions: unknown[];
    invalidRecords: unknown[];
    normalizedUnits: unknown[];
  };

  return (
    <div className="app-section app-section-gap">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="app-title font-bold">Legacy Migration Report</h1>
          <p className="text-sm text-muted-foreground">Generated {new Date(r.generatedAt).toLocaleString()} — advisory only, no data is migrated automatically.</p>
        </div>
        <Badge variant={r.migrationReadiness ? 'active' : 'inactive'} className="shrink-0">{r.migrationReadiness ? 'Ready' : 'Not Ready'}</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Source Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {Object.entries(r.sourceSummary).map(([key, value]) => (
            <div key={key} className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">{key}</p>
              <p className="text-lg font-semibold">{value}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {r.blockers.length > 0 && (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-destructive">Blockers ({r.blockers.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {r.blockers.map((b, i) => (
              <p key={i}>{b}</p>
            ))}
          </CardContent>
        </Card>
      )}

      {r.warnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Warnings ({r.warnings.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            {r.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Exact Match Candidates</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="app-kpi-value font-semibold">{r.identityCandidates.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Ambiguous Groups</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="app-kpi-value font-semibold">{r.ambiguousGroups.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>SKU / Barcode Collisions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="app-kpi-value font-semibold">{r.skuCollisions.length + r.barcodeCollisions.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Invalid / Unmapped Records</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="app-kpi-value font-semibold">{r.invalidRecords.length}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
