'use client';

import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { ProductVariantResponse, RecipeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useRecipesList, useDeleteRecipe } from '@/hooks/queries/use-recipes';
import { RecipeLineFormDialog } from './recipe-line-form-dialog';
import { SimulateDialog } from './simulate-dialog';

interface RecipeLinesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant: ProductVariantResponse;
}

/** View + manage a single variant's master recipe ingredient lines (create/edit/delete each line, plus a deduction simulator). */
export function RecipeLinesDialog({ open, onOpenChange, variant }: RecipeLinesDialogProps) {
  const { data: lines, isLoading, isError, refetch } = useRecipesList(open ? variant.id : undefined);
  const deleteRecipe = useDeleteRecipe(variant.id);

  const [lineForm, setLineForm] = useState<{ open: boolean; line?: RecipeResponse }>({ open: false });
  const [deletingLine, setDeletingLine] = useState<RecipeResponse | null>(null);
  const [simulateOpen, setSimulateOpen] = useState(false);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {variant.name} — {variant.size_label}
            </DialogTitle>
            <DialogDescription>Master recipe ingredient lines for this variant.</DialogDescription>
          </DialogHeader>

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setSimulateOpen(true)}>
              Simulate
            </Button>
            <Button size="sm" onClick={() => setLineForm({ open: true })}>
              <Plus className="mr-2 h-4 w-4" />
              Add Ingredient Line
            </Button>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-10">
              <LoadingSpinner />
            </div>
          ) : isError ? (
            <ErrorState retry={() => void refetch()} />
          ) : !lines || lines.length === 0 ? (
            <EmptyState title="No ingredient lines yet" description="Add ingredient lines to define this variant's master recipe." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ingredient</TableHead>
                  <TableHead>Applies To</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell>{line.ingredient_name}</TableCell>
                    <TableCell>{line.flavor_name ?? 'Base (all flavors)'}</TableCell>
                    <TableCell>
                      {line.quantity} {line.unit}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={`Edit ${line.ingredient_name}`}
                          onClick={() => setLineForm({ open: true, line })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          aria-label={`Delete ${line.ingredient_name}`}
                          onClick={() => setDeletingLine(line)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      <RecipeLineFormDialog
        open={lineForm.open}
        onOpenChange={(nextOpen) => setLineForm((prev) => ({ ...prev, open: nextOpen }))}
        variant={variant}
        existingLines={lines ?? []}
        editingLine={lineForm.line}
      />

      <SimulateDialog open={simulateOpen} onOpenChange={setSimulateOpen} variant={variant} />

      {deletingLine && (
        <ConfirmDialog
          open
          onOpenChange={(nextOpen) => !nextOpen && setDeletingLine(null)}
          title={`Remove ${deletingLine.ingredient_name}?`}
          description="This removes the ingredient line from this variant's master recipe. This action cannot be undone."
          confirmLabel="Remove"
          variant="danger"
          onConfirm={async () => {
            await deleteRecipe.mutateAsync(deletingLine.id);
          }}
        />
      )}
    </>
  );
}
