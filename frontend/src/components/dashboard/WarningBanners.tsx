// One banner per /wallet/status warnings value, in the order the backend sent them, each with its short fix.
import { warningText } from '../../lib/messages'

export function WarningBanners({ warnings, validUntilIso }: { warnings: readonly string[]; validUntilIso?: string }) {
  if (!warnings.length) return null
  return (
    <ul className="banners" aria-label="Warnings">
      {warnings.map((code) => {
        const w = warningText(code)
        return (
          <li key={code} className={`banner ${w.tone}`} data-warning={code}>
            <strong>{w.text}</strong>
            {code === 'AGENT_EXPIRES_SOON' && validUntilIso && <> Ends {validUntilIso}.</>}
            {w.fix && <div className="fix">Fix: {w.fix}</div>}
          </li>
        )
      })}
    </ul>
  )
}
