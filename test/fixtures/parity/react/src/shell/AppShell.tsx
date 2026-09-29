import { Link, Outlet } from 'react-router-dom';
import { ROUTES } from '../router/routes';

const TABS = [
  { to: ROUTES.home, label: 'Home' },
  { to: ROUTES.profile, label: 'Profile' },
];

export function AppShell() {
  return (
    <div>
      <Outlet />
      <nav>
        {TABS.map((t) => (
          <Link key={t.to} to={t.to}>{t.label}</Link>
        ))}
      </nav>
    </div>
  );
}
