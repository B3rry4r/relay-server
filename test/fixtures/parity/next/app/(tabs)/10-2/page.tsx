// canonicalId: c_10_2 route: /10-2
'use client';
import { useRouter } from 'next/navigation';
import { assets } from '@/lib/resources/assets';
import { showModal_10_9 } from '@/components/FilterSheet';

const ICONS = { search: 'assets/icons/vector_10_20.svg' };

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

function DeliveryMapCard() {
  return (
    <div style={{ borderRadius: 12 }}>
      <svg width="100%" viewBox="0 0 380 380">
        <rect x="0" y="0" width="380" height="380" fill="#12ae89" />
        <path d="M0 190h380M190 0v380" stroke="#1a1a1a" />
      </svg>
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const bannerKey: keyof typeof assets = 'promoBanner';
  return (
    <main style={{ padding: 16, color: '#12ae89' }}>
      <SectionHeading>Home</SectionHeading>
      <SearchGlyph />
      <div style={{ height: 120, backgroundImage: `url(/${assets.mapDark})` }} />
      <img src={'/' + assets.userAvatar} alt="" width={40} height={40} />
      <img src={ICONS.search} alt="search" />
      <img src={`/${assets[bannerKey]}`} alt="promo" />
      <DeliveryMapCard />
      <button onClick={() => {}}>Settings</button>
      <button onClick={() => router.push('/10-5')}>View details</button>
      <button onClick={() => showModal_10_9()}>Filter</button>
    </main>
  );
}
