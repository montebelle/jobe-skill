import type { Metadata } from 'next';
import { Geist, Geist_Mono, Fraunces } from 'next/font/google';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
const fraunces = Fraunces({
  variable: '--font-fraunces',
  subsets: ['latin'],
  axes: ['SOFT', 'opsz'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Jobe — Career Intelligence',
  description:
    'Self-hosted dashboard for the Jobe career-intelligence pipeline: discovered, evaluated, queued, applied, responded, interviewing, offer.',
  icons: { icon: '/icon.svg', shortcut: '/icon.svg', apple: '/icon.svg' },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable}`}
    >
      <body className="min-h-screen antialiased">
        <div className="relative z-10 flex min-h-screen">
          <Sidebar />
          <div className="flex min-h-screen flex-1 flex-col">
            <TopBar />
            <main className="flex-1 px-6 pb-16 pt-6 md:px-10 lg:px-14">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
