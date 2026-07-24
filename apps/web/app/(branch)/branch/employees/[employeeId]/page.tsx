'use client';

import { use } from 'react';
import { EmployeeDetailView } from '@/components/branch-ops/employee-detail-view';

interface BranchEmployeeDetailPageProps {
  params: Promise<{ employeeId: string }>;
}

export default function BranchEmployeeDetailPage({ params }: BranchEmployeeDetailPageProps) {
  const { employeeId } = use(params);
  return <EmployeeDetailView employeeId={employeeId} basePath="/branch" />;
}
