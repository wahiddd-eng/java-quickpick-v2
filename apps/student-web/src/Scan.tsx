import { useEffect, useRef, useState, type FormEvent } from 'react';
import { navigate } from './lib';
import { Back, Icon } from './ui';

/** Pull the shop token out of a scanned QR (our URL https://…/s/<token>) or a typed code. */
export function tokenFrom(text: string): string | null {
  const t = text.trim();
  const m = t.match(/\/s\/([A-Za-z0-9_-]{4,64})(?:[/?#]|$)/);
  if (m) return m[1];
  const bare = t.replace(/\s+/g, '').toLowerCase();
  return /^[a-z0-9_-]{4,64}$/.test(bare) ? bare : null;
}

declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => { detect(src: CanvasImageSource): Promise<Array<{ rawValue: string }>> };
  }
}

/**
 * In-app scanner. Most students will simply point their phone camera at the counter QR (it opens /s/<token> directly);
 * this screen is for people already in the app. Uses the browser's BarcodeDetector where available (Chrome on
 * Android); otherwise falls back to typing the code printed under the QR.
 */
export function Scan() {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'idle' | 'starting' | 'scanning' | 'unsupported' | 'denied'>(window.BarcodeDetector ? 'idle' : 'unsupported');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (state !== 'starting') return;
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        setState('scanning');
        const detector = new window.BarcodeDetector!({ formats: ['qr_code'] });
        const tick = async () => {
          if (stopped || !video.current) return;
          try {
            const found = await detector.detect(video.current);
            const token = found.map((f) => tokenFrom(f.rawValue)).find(Boolean);
            if (token) return navigate(`/s/${token}`);
            if (found.length) setMsg('That QR code isn’t a Java QuickPick shop code.');
          } catch {
            /* frame not ready */
          }
          timer = window.setTimeout(tick, 300);
        };
        void tick();
      } catch {
        setState('denied');
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [state]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = tokenFrom(code);
    if (t) navigate(`/s/${t}`);
    else setMsg('Type the code printed under the shop’s QR, e.g. abcd-efgh-jkmn.');
  };

  return (
    <>
      <Back href="/">Home</Back>
      <div className="page-head">
        <h1>Scan the shop’s QR</h1>
        <p>Every shop at Java Green has its own QR on the counter. Scanning it opens that shop’s menu — no searching.</p>
      </div>
      {state === 'idle' && <button className="btn primary block" onClick={() => setState('starting')}>{Icon.qr} Open camera</button>}
      {(state === 'starting' || state === 'scanning') && (
        <div className="scanner">
          <video ref={video} playsInline muted aria-label="Camera preview" />
          <span className="frame" aria-hidden />
          <p className="sub small">{state === 'starting' ? 'Starting camera…' : 'Point at the QR on the counter'}</p>
        </div>
      )}
      {state === 'unsupported' && <p className="alert info">This browser can’t scan inside the app. Use your phone’s camera app to scan the counter QR — it opens Java QuickPick directly — or type the code below.</p>}
      {state === 'denied' && <p className="alert warn">Camera access was blocked. Use your phone’s camera app instead, or type the code below.</p>}
      {msg && <p className="alert warn" style={{ marginTop: 12 }}>{msg}</p>}
      <form onSubmit={submit} className="section">
        <div className="field"><label htmlFor="qrcode">Or type the code under the QR</label><input id="qrcode" autoCapitalize="none" autoComplete="off" value={code} onChange={(e) => { setCode(e.target.value); setMsg(''); }} placeholder="abcd-efgh-jkmn" /></div>
        <button className="btn block" style={{ marginTop: 12 }} disabled={!code.trim()}>Open shop</button>
      </form>
    </>
  );
}
