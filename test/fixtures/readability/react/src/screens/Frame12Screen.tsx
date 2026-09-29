// canonicalId: c_283_1967 route: /283-1967
import { useState } from 'react';
import { AppTheme } from '../theme/theme';

const BRAND = '#12ae89';

function BackButton() {
  return (
    <div className="flex items-center gap-[8px]">
      <span className="text-[14px] text-[#1a1a1a]">Back</span>
      <img src="/assets/icons/vector_10_20.svg" alt="" />
    </div>
  );
}

export function Frame12Screen() {
  // matches the reference (frame 64, IR "Rectangle 7")
  return (
    <main style={{ background: AppTheme.color.brand, padding: 24 }}>
      <section className="relative">
        <div className="absolute top-[103px] left-[24px]" style={{ width: 45, height: 45, color: BRAND }}>
          <p>Group 4</p>
        </div>
      </section>
      <BackButton />
      <button onClick={() => {}}>Go</button>
      <button onClick={() => console.log('todo')}>Later</button>
    </main>
  );
}
