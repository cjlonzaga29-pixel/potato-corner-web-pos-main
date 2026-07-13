export default async function PublicReceiptPage({ params }: { params: Promise<{ txn: string }> }) {
  const { txn } = await params;

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">Receipt {txn}</h1>
      <p className="text-muted-foreground text-sm">Phase 0 placeholder — implemented in a later phase.</p>
    </div>
  );
}
