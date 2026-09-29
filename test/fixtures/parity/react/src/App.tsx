import { Routes, Route, Navigate } from 'react-router-dom';
import { ROUTES } from './router/routes';
import { AppShell } from './shell/AppShell';
import { LoginScreen } from './screens/Login/LoginScreen';
import { HomeScreen } from './screens/Home/HomeScreen';
import { IPhone1415Pro57Screen } from './screens/IPhone1415Pro57Screen';
import { Frame123Screen } from './screens/Frame123Screen';
import { PlaceholderScreen } from './screens/PlaceholderScreen';
import { LoginPreview } from './screens/Login/LoginPreview';
import { SettingsPreview } from './screens/SettingsPreview';

export default function App() {
  return (
    <Routes>
      <Route path={ROUTES.login} element={<LoginScreen />} />
      <Route element={<AppShell />}>
        <Route path={ROUTES.home} element={<HomeScreen />} />
        <Route path={ROUTES.profile} element={<Frame123Screen />} />
      </Route>
      <Route path={ROUTES.c103} element={<IPhone1415Pro57Screen />} />
      <Route path={ROUTES.details} element={<PlaceholderScreen title="Details" />} />
      <Route path={ROUTES.logoutDialog} element={<PlaceholderScreen title="Log out" />} />
      <Route path={ROUTES.filterSheet} element={<PlaceholderScreen title="Filter" />} />
      <Route path="/_preview/10-1" element={<LoginPreview />} />
      <Route path="/_preview/10-3" element={<SettingsPreview />} />
      <Route path="*" element={<Navigate to={ROUTES.login} replace />} />
    </Routes>
  );
}
