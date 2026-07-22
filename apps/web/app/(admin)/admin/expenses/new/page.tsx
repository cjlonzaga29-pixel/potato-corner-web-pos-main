'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ExpenseForm, type ExpenseFormValues } from '@/components/admin/expense-form';
import { useCreateExpense } from '@/hooks/queries/use-expenses';

export default function NewExpensePage() {
  const router = useRouter();
  const createExpense = useCreateExpense();

  async function handleCreate(values: ExpenseFormValues) {
    const created = await createExpense.mutateAsync(values);
    router.push(`/admin/expenses/${created.id}`);
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/admin/expenses">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to expenses
        </Link>
      </Button>

      <h1 className="text-2xl font-bold">New Expense</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Expense Details</CardTitle>
        </CardHeader>
        <CardContent>
          <ExpenseForm
            mode="create"
            onSubmit={handleCreate}
            isSubmitting={createExpense.isPending}
            onCancel={() => router.push('/admin/expenses')}
          />
        </CardContent>
      </Card>
    </div>
  );
}
