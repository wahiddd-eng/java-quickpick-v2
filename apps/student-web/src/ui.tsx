import type { ReactNode } from 'react';

export const Icon = {
  chevronRight: <svg className="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 6 6 6-6 6" /></svg>,
  chevronLeft: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 6-6 6 6 6" /></svg>,
  check: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5 10 17l9-10" /></svg>,
  cup: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 9h13v4a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6V9Z" /><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17" /><path d="M8 3v3M12 3v3" /></svg>,
  clock: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  qr: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></svg>,
  bell: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>,
};

export const Back = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="back" href={href}>
    {Icon.chevronLeft}
    {children}
  </a>
);

export const Alert = ({ tone, children }: { tone: 'error' | 'info' | 'warn' | 'good'; children: ReactNode }) => (
  <div className={`alert ${tone}`} role={tone === 'error' ? 'alert' : undefined}>
    {children}
  </div>
);

export const DietMark = ({ diet }: { diet: 'VEG' | 'NON_VEG' | 'EGG' | null }) =>
  diet ? <span className={'diet ' + diet.toLowerCase()} role="img" aria-label={diet === 'VEG' ? 'Vegetarian' : diet === 'EGG' ? 'Contains egg' : 'Non-vegetarian'} title={diet === 'VEG' ? 'Vegetarian' : diet === 'EGG' ? 'Contains egg' : 'Non-vegetarian'} /> : null;

export const ModeBadge = ({ mode }: { mode: 'PREORDER' | 'WALKIN_QR' }) => <span className={'mode ' + (mode === 'WALKIN_QR' ? 'walkin' : 'pre')}>{mode === 'WALKIN_QR' ? 'Walk-in' : 'Pre-order'}</span>;
