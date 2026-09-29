import { AppTheme } from '../theme/theme';

function BackButton() {
  return (
    <div className="flex items-center gap-[8px]">
      <span className="text-[14px] text-[#1a1a1a]">Return</span>
      <img src="/assets/icons/back.svg" alt="" />
    </div>
  );
}

export function ProfileScreen() {
  return (
    <main style={{ background: 'rgba(0, 0, 0, 0.5)', borderRadius: 12 }}>
      <BackButton />
      {/* <OldWidget /> */}
      <p style={{ fontSize: 21.94 }}>Don't panic — it's fine</p>
    </main>
  );
}
