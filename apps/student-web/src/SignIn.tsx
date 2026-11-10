import { useState, type FormEvent } from 'react';
import { api, errMsg } from './lib';
import { Alert } from './ui';

/** Email one-time code. Shown inline only when needed (checkout, orders) — browsing needs no account. */
export function SignIn({ onDone, title = 'Sign in to continue', compact = false }: { onDone: () => void; title?: string; compact?: boolean }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const request = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api.post<{ devCode?: string }>('/auth/otp/request', { email });
      setSent(true);
      setDevCode(r.devCode ?? null);
    } catch (er) {
      setErr(errMsg(er));
    } finally {
      setBusy(false);
    }
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api.post<{ token: string }>('/auth/otp/verify', { email, code, name: name || undefined });
      api.setToken(r.token);
      window.dispatchEvent(new Event('qp-login'));
      onDone();
    } catch (er) {
      setErr(errMsg(er));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={'signin' + (compact ? ' compact' : '')}>
      <h2>{title}</h2>
      <p className="sub small" style={{ marginTop: 4 }}>We’ll send a one-time code to your college email. No password, no app to install.</p>
      {!sent ? (
        <form onSubmit={request}>
          <div className="field"><label htmlFor="name">Your name</label><input id="name" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="First name" /></div>
          <div className="field"><label htmlFor="email">College email</label><input id="email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@srmist.edu.in" required /></div>
          {err && <div style={{ marginTop: 14 }}><Alert tone="error">{err}</Alert></div>}
          <button className="btn primary block" disabled={busy || !email}>{busy ? 'Sending code…' : 'Send sign-in code'}</button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <div className="field">
            <label htmlFor="code">Enter the 6-digit code</label>
            <input id="code" className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            <p className="hint">Sent to {email}. <button type="button" className="linkbtn" onClick={() => { setSent(false); setCode(''); setErr(''); }}>Use a different email</button></p>
          </div>
          {devCode && <div style={{ marginTop: 14 }}><Alert tone="warn"><span>Test mode: your code is <b className="num">{devCode}</b>. Email delivery isn’t connected yet.</span></Alert></div>}
          {err && <div style={{ marginTop: 14 }}><Alert tone="error">{err}</Alert></div>}
          <button className="btn primary block" disabled={busy || code.length !== 6}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      )}
    </div>
  );
}
