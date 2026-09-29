import { useEffect } from 'react';
import { IPhone1415Pro57Screen } from './IPhone1415Pro57Screen';
import { showModal_10_8 } from '../modal/LogoutDialog';

// Verify harness: mounts Settings and auto-presents the Log out modal (m_10_8).
export function SettingsPreview() {
  useEffect(() => { showModal_10_8(); }, []);
  return <IPhone1415Pro57Screen />;
}
