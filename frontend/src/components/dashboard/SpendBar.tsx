// spentToday against dailyLimit, exactly as the contract returned them. Nothing is reset or recomputed on the client:
// both values already roll over at 00:00 UTC on chain. The width is the only derived number (BigInt, whole percent).
import type { Amount } from '../../api/types'
import { percent } from '../../lib/format'

export function SpendBar({ spentToday, dailyLimit, remaining }: { spentToday: Amount; dailyLimit: Amount; remaining: Amount }) {
  const pct = percent(spentToday, dailyLimit)
  return (
    <div className="spend">
      <div
        className="bar"
        role="progressbar"
        aria-label="Spent today"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${spentToday.mUSDC} of ${dailyLimit.mUSDC} mUSDC`}
      >
        <div className={`fill${pct >= 90 ? ' high' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="spend-text">
        <span>
          Spent today <strong>{spentToday.mUSDC}</strong> of {dailyLimit.mUSDC} mUSDC
        </span>
        <span>
          Remaining today <strong>{remaining.mUSDC} mUSDC</strong>
        </span>
      </div>
      <div className="muted">Resets on chain at 00:00 UTC.</div>
    </div>
  )
}
