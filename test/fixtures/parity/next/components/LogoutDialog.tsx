'use client';
import { modalController } from './modalController';

export function LogoutDialog() {
  return <div role="dialog">Log out?</div>;
}

export function showModal_10_8() {
  modalController.open('m_10_8', <LogoutDialog />);
}
