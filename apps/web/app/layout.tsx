import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/auth';

export const metadata: Metadata = { title: 'CloudConnect AI', description: 'AI-powered business phone, messaging, and video platform', manifest: '/manifest.webmanifest' };
export const viewport: Viewport = { themeColor: '#2550eb', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><AuthProvider>{children}</AuthProvider></body></html>;
}
