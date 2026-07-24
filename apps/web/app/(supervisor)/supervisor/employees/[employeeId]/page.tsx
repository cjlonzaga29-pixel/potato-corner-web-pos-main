'use client';

import { use } from 'react';
import { EmployeeDetailView } from '@/components/branch-ops/employee-detail-view';

interface SupervisorEmployeeDetailPageProps {
  params: Promise<{ employeeId: string }>;
}

export default function SupervisorEmployeeDetailPage({ params }: SupervisorEmployeeDetailPageProps) {
  const { employeeId } = use(params);
  return <EmployeeDetailView employeeId={employeeId} basePath="/supervisor" />;
}
