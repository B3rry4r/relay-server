import { Frame12Screen } from './screens/Frame12Screen';
import { ProfileScreen } from './screens/ProfileScreen';

export function App() {
  const wide = window.innerWidth > 600;
  return wide ? <ProfileScreen /> : <Frame12Screen />;
}
