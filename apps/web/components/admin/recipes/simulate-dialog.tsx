'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProductVariantResponse, SimulateDeductionResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useBranches } from '@/hooks/queries/use-branches';
import { useSimulateDeduction } from '@/hooks/queries/use-recipes';

const ALL_FLAVORS_VALUE = '__none__';
const NO_BRANCH_VALUE = '__master_only__';

interface SimulateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant: ProductVariantResponse;
}

/** CR-001 deduction preview — read-only, does not touch stock. */
export function SimulateDialog({ open, onOpenChange, variant }: SimulateDialogProps) {
  const [quantitySold, setQuantitySold] = useState('1');
  const [flavorId, setFlavorId] = useState(ALL_FLAVORS_VALUE);
  const [branchId, setBranchId] = useState(NO_BRANCH_VALUE);
  const [result, setResult] = useState<SimulateDeductionResponse | null>(null);
  const { data: branchData } = useBranches({ status: 'active', limit: 100 });
  const simulate = useSimulateDeduction();

  function handleOpenChange(next: boolean) {
    if (next) setResult(null);
    onOpenChange(next);
  }

  async function handleRun() {
    const response = await simulate.mutateAsync({
      product_variant_id: variant.id,
      flavor_id: flavorId === ALL_FLAVORS_VALUE ? null : flavorId,
      quantity_sold: Number(quantitySold),
      branch_id: branchId === NO_BRANCH_VALUE ? undefined : branchId,
    });
    setResult(response);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Simulate Deduction</DialogTitle>
          <DialogDescription>
            Preview ingredient deduction for {variant.name} ({variant.size_label}) without changing stock.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="simulate-quantity">Quantity Sold</Label>
              <Input
                id="simulate-quantity"
                type="number"
                min="1"
                step="1"
                value={quantitySold}
                onChange={(event) => setQuantitySold(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="simulate-flavor">Flavor</Label>
              <Select value={flavorId} onValueChange={setFlavorId}>
                <SelectTrigger id="simulate-flavor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FLAVORS_VALUE}>None</SelectItem>
                  {variant.flavors.map((flavor) => (
                    <SelectItem key={flavor.flavor_id} value={flavor.flavor_id}>
                      {flavor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="simulate-branch">Branch</Label>
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger id="simulate-branch">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_BRANCH_VALUE}>Master only</SelectItem>
                  {(branchData?.branches ?? []).map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button type="button" onClick={() => void handleRun()} disabled={simulate.isPending || !quantitySold}>
            {simulate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Run Simulation
          </Button>

          {result &&
            (result.lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No ingredient lines apply to this selection.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ingredient</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.lines.map((line) => (
                    <TableRow key={`${line.ingredient_id}-${line.source}`}>
                      <TableCell>{line.ingredient_name}</TableCell>
                      <TableCell>
                        {line.quantity} {line.unit}
                      </TableCell>
                      <TableCell className="text-xs uppercase text-muted-foreground">{line.source.replace('_', ' ')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ))}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
