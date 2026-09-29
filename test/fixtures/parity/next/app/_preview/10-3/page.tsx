'use client';
import { useEffect } from 'react';
import SettingsPage from '../../10-3/page';
import { showModal_10_8 } from '@/components/LogoutDialog';

// Verify harness: mounts Settings and auto-presents the Log out modal (m_10_8).
export default function SettingsPreviewPage() {
  useEffect(() => { showModal_10_8(); }, []);
  return <SettingsPage />;
}
