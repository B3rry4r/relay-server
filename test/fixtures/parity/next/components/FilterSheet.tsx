'use client';
import { modalController } from './modalController';

export function FilterSheet() {
  return <div role="dialog">Filter</div>;
}

export function showModal_10_9() {
  modalController.open('m_10_9', <FilterSheet />);
}
