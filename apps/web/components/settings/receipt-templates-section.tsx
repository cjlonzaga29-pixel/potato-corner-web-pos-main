'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';
import { useBranchReceiptConfig, useUpdateBranchReceiptConfig } from '@/hooks/queries/use-settings';
import { useAuthStore } from '@/stores/auth.store';

const MAX_LENGTH = 500;

interface FormState {
  headerText: string;
  footerText: string;
  showBranchLogo: boolean;
}

const EMPTY_FORM: FormState = { headerText: '', footerText: '', showBranchLogo: true };

export function ReceiptTemplatesSection() {
  const isAdmin = useAuthStore((s) => s.isAdmin());
  const [branchId, setBranchId] = useState<string | null>(null);
  const { data: branchesData } = useBranches({ limit: 100 });
  const { data: config, isLoading, isError } = useBranchReceiptConfig(branchId);
  const updateConfig = useUpdateBranchReceiptConfig(branchId ?? '');

  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    setForm(
      config
        ? { headerText: config.headerText ?? '', footerText: config.footerText ?? '', showBranchLogo: config.showBranchLogo }
        : EMPTY_FORM,
    );
  }, [config, branchId]);

  function handleSave() {
    if (!branchId) return;
    updateConfig.mutate({
      headerText: form.headerText || null,
      footerText: form.footerText || null,
      showBranchLogo: form.showBranchLogo,
    });
  }

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Receipt Templates</CardTitle>
          <CardDescription>Per-branch receipt header, footer, and logo configuration.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Only Super Admins can configure receipt templates.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Receipt Templates</CardTitle>
        <CardDescription>Per-branch receipt header, footer, and logo configuration.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="branchId">Branch</Label>
          <Select value={branchId ?? undefined} onValueChange={setBranchId}>
            <SelectTrigger id="branchId">
              <SelectValue placeholder="Select a branch" />
            </SelectTrigger>
            <SelectContent>
              {(branchesData?.branches ?? []).map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!branchId && <p className="text-sm text-muted-foreground">Select a branch to configure its receipt template.</p>}

        {branchId && isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {branchId && isError && <p className="text-sm text-destructive">Failed to load receipt configuration.</p>}

        {branchId && !isLoading && !isError && (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="headerText">Header text</Label>
                <Textarea
                  id="headerText"
                  maxLength={MAX_LENGTH}
                  value={form.headerText}
                  onChange={(e) => setForm({ ...form, headerText: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{form.headerText.length}/{MAX_LENGTH}</p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="footerText">Footer text</Label>
                <Textarea
                  id="footerText"
                  maxLength={MAX_LENGTH}
                  value={form.footerText}
                  onChange={(e) => setForm({ ...form, footerText: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{form.footerText.length}/{MAX_LENGTH}</p>
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <Label htmlFor="showBranchLogo">Show branch logo</Label>
                <Switch
                  id="showBranchLogo"
                  checked={form.showBranchLogo}
                  onCheckedChange={(checked) => setForm({ ...form, showBranchLogo: checked })}
                />
              </div>

              <Button onClick={handleSave} disabled={updateConfig.isPending}>
                {updateConfig.isPending ? 'Saving...' : 'Save changes'}
              </Button>
            </div>

            <div className="rounded-md border bg-muted/30 p-4 font-mono text-xs">
              <p className="mb-2 text-center text-sm font-semibold">Preview</p>
              {form.showBranchLogo && <p className="mb-2 text-center">[ Branch Logo ]</p>}
              {form.headerText && <p className="whitespace-pre-wrap text-center">{form.headerText}</p>}
              <div className="my-2 border-t border-dashed" />
              <p>1x Classic Potato — ₱65.00</p>
              <p>1x Cheese Overload — ₱85.00</p>
              <div className="my-2 border-t border-dashed" />
              <p className="font-semibold">Total: ₱150.00</p>
              <div className="my-2 border-t border-dashed" />
              {form.footerText && <p className="whitespace-pre-wrap text-center">{form.footerText}</p>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
