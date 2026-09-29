import Link from 'next/link';
import type { ReactNode } from 'react';

const TABS = [
  { href: '/10-2', label: 'Home' },
  { href: '/10-4', label: 'Profile' },
];

export default function TabsLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      {children}
      <nav>
        {TABS.map((t) => (
          <Link key={t.href} href={t.href}>{t.label}</Link>
        ))}
      </nav>
    </div>
  );
}
