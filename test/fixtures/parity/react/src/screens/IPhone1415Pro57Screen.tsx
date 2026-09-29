// canonicalId: c_10_3 route: /10-3
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '../router/routes';
import { assets } from '../resources/assets';
import { showModal_10_8 } from '../modal/LogoutDialog';

function SectionHeading({ children }: { children: string }) {
  return (
    <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>{children}</h2>
  );
}

export function Badge({ label }: { label: string }) {
  return (
    <span style={{ borderRadius: 12, padding: 8 }}>{label}</span>
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

export function IPhone1415Pro57Screen() {
  const navigate = useNavigate();
  return (
    <section style={{ padding: 16 }}>
      <SectionHeading>Settings</SectionHeading>
      <Badge label="beta" />
      <SearchGlyph />
      <svg width="18" height="18" viewBox="0 0 18 18"><path d="M1 1h16v16H1z" fill="#1a1a1a" /></svg>
      <button onClick={() => {}}>Resolve</button>
      <button onClick={() => navigate(ROUTES.login)}>Sign out</button>
      <PillButton label="Save" />
      {/* TODO: open the log-out dialog — showModal_10_8 is imported but never wired */}
      <button onClick={() => {}}>Log out</button>
    </section>
  );
}
