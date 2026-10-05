// QR-код входа Steam — общий для привязки аккаунта и веб-входа.

import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'

export function Qr({ url, ok, failed }: { url: string | null; ok: boolean; failed: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!url || !ref.current) return
    QRCode.toCanvas(ref.current, url, { width: 168, margin: 1, color: { dark: '#ecebe8', light: '#1b1b1e' } }).catch(() => { })
  }, [url])
  if (ok) return <div className="v2-acc-qr is-ok">готово</div>
  if (failed) return <div className="v2-acc-qr"><span className="v2-hint">кода нет</span></div>
  if (!url) return <div className="v2-acc-qr"><span className="v2-hint">код готовится…</span></div>
  return <canvas ref={ref} className="v2-acc-qr" aria-label="QR-код для входа" />
}
