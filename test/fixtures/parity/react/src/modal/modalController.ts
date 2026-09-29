import type { ReactNode } from 'react';

type Listener = (id: string | null, node: ReactNode | null) => void;
const listeners = new Set<Listener>();

export const modalController = {
  open(id: string, node: ReactNode) { listeners.forEach((l) => l(id, node)); },
  close() { listeners.forEach((l) => l(null, null)); },
  subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; },
};
