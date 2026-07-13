import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({ data: { status: 'ok' }, error: null, meta: null });
}
