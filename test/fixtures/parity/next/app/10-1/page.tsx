// canonicalId: c_10_1 route: /10-1
'use client';
import { useRouter } from 'next/navigation';

function PillButton({ label }: { label: string }) {
  return (
    <span style={{ background: '#12ae89', borderRadius: 12, padding: 8 }}>{label}</span>
  );
}

export default function LoginPage() {
  const router = useRouter();
  return (
    <div style={{ padding: 16 }}>
      <img src="assets/images/user_avatar.png" alt="" width={64} height={64} />
      <PillButton label="Welcome" />
      <button onClick={() => router.push('/10-2')}>Sign in</button>
    </div>
  );
}
