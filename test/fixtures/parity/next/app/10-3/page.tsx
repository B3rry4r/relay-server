// canonicalId: c_10_3 route: /10-3
'use client';
import { useRouter } from 'next/navigation';
import { assets } from '@/lib/resources/assets';
import { showModal_10_8 } from '@/components/LogoutDialog';

function SectionHeading({ children }: { children: string }) {
  return (
    <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>{children}</h2>
  );
}

function SearchGlyph() {
  return (
    <img src={`/${assets.searchIcon}`} alt="" width={18} height={18} />
  );
}

function PillButton({ label }: { label: string }) {
  return (
    <span style={{ background: '#1a1a1a', borderRadius: 12, padding: 8 }}>{label}</span>
  );
}

export default function IPhone1415Pro57Page() {
  const router = useRouter();
  return (
    <section style={{ padding: 16 }}>
      <SectionHeading>Settings</SectionHeading>
      <SearchGlyph />
      <svg width="18" height="18" viewBox="0 0 18 18"><path d="M1 1h16v16H1z" fill="#1a1a1a" /></svg>
      <button onClick={() => {}}>Resolve</button>
      <button onClick={() => router.push('/10-1')}>Sign out</button>
      <PillButton label="Save" />
      {/* TODO: open the log-out dialog — showModal_10_8 is imported but never wired */}
      <button onClick={() => {}}>Log out</button>
    </section>
  );
}
