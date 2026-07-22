import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/shared/providers';
import { PostHogProvider } from '@/components/providers/posthog-provider';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Potato Corner POS',
  description: 'Enterprise Web POS and Branch Management Platform',
  // public/manifest.json exists but was never linked — Next.js only
  // auto-serves a manifest placed at app/manifest.ts/.json, not one under
  // public/, so without this the browser has no way to discover it and the
  // PWA install prompt never appears. See public/icons/README.md for a
  // still-open, separate blocker: the icons this manifest references
  // (icon-192x192.png, icon-512x512.png) don't exist yet.
  manifest: '/manifest.json',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="antialiased">
        <PostHogProvider>
          <Providers>{children}</Providers>
        </PostHogProvider>
      </body>
    </html>
  );
}
