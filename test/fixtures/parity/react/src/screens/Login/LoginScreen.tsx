// canonicalId: c_10_1 route: /10-1
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '../../router/routes';

function PillButton({ label }: { label: string }) {
  return (
    <span style={{ background: '#12ae89', borderRadius: 12, padding: 8 }}>{label}</span>
  );
}

export function LoginScreen() {
  const navigate = useNavigate();
  return (
    <div style={{ padding: 16 }}>
      <img src="assets/images/user_avatar.png" alt="" width={64} height={64} />
      <PillButton label="Welcome" />
      <button onClick={() => navigate(ROUTES.home)}>Sign in</button>
    </div>
  );
}
