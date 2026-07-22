'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ROLES } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { ExpenseForm, type ExpenseFormValues } from '@/components/admin/expense-form';
import { ExpenseDeleteDialog } from '@/components/admin/expense-delete-dialog';
import { ExpenseReceiptUpload } from '@/components/admin/expense-receipt-upload';
import { useAuth } from '@/hooks/use-auth';
import { useExpense, useUpdateExpense } from '@/hooks/queries/use-expenses';

interface ExpenseDetailPageProps {
  params: Promise<{ expenseId: string }>;
}

export default function ExpenseDetailPage({ params }: ExpenseDetailPageProps) {
  const { expenseId } = use(params);
  const router = useRouter();
  const { user } = useAuth();
  const { data: expense, isLoading, isError, refetch } = useExpense(expenseId);
  const updateExpense = useUpdateExpense(expenseId);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const isSuperAdmin = user?.role === ROLES.SUPER_ADMIN;

  async function handleUpdate(values: ExpenseFormValues) {
    await updateExpense.mutateAsync(values);
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (isError || !expense) {
    return <ErrorState title="Expense not found" retry={() => void refetch()} />;
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/admin/expenses">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to expenses
        </Link>
      </Button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Edit Expense</h1>
        {isSuperAdmin && (
          <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
            Delete Expense
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Expense Details</CardTitle>
        </CardHeader>
        <CardContent>
          <ExpenseForm
            mode="edit"
            initialValues={{
              branch_id: expense.branch_id,
              category: expense.category,
              amount: expense.amount,
              vendor_name: expense.vendor_name ?? undefined,
              description: expense.description ?? undefined,
              incurred_at: expense.incurred_at,
            }}
            onSubmit={handleUpdate}
            isSubmitting={updateExpense.isPending}
            onCancel={() => router.push('/admin/expenses')}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Receipt</CardTitle>
          <CardDescription>JPEG, PNG, or WebP, up to 5MB.</CardDescription>
        </CardHeader>
        <CardContent>
          <ExpenseReceiptUpload expenseId={expense.id} currentReceiptUrl={expense.receipt_url} />
        </CardContent>
      </Card>

      <ExpenseDeleteDialog open={deleteOpen} onOpenChange={setDeleteOpen} expense={expense} />
    </div>
  );
}
