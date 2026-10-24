// What the owner is about to sign, decoded from the calldata that will be sent (the browser's own rebuild), plus any
// difference from the backend's ownerApproval. Pure view.
import type { DecodedCall, Mismatch, Rebuilt } from '../../chain/approval'
import { amountText } from '../../chain/approval'
import { formatTime, shortAddress } from '../../lib/format'
import { inert } from '../../lib/text'

export function ApprovalDetails({ rebuilt, wallet }: { rebuilt: Rebuilt; wallet: string }) {
  return (
    <div className="approval-details" data-testid="decoded">
      <p>
        <strong>You sign:</strong> <code>{shortAddress(wallet)}</code>.executeBatch(dest, [], func), a normal transaction from the owner account.
      </p>
      <ol className="calls">
        {rebuilt.calls.map((c, i) => <CallLine key={i} call={c} />)}
      </ol>
      <dl>
        <dt>Credits</dt><dd data-field="credits">{rebuilt.credits.toString()}</dd>
        <dt>Price (merchant.quote, read now)</dt><dd data-field="price">{amountText(rebuilt.price)}</dd>
        <dt>Standing merchant allowance</dt><dd data-field="standing">{amountText(rebuilt.standing)}, unchanged afterwards (the batch approves standing + price and the purchase spends the price)</dd>
        <dt>Read at</dt><dd>{formatTime(rebuilt.readAt)?.local}</dd>
      </dl>
      <p className="muted">This is an owner purchase: the agent's spentToday and limits do not change.</p>
    </div>
  )
}

function CallLine({ call }: { call: DecodedCall }) {
  return (
    <li>
      <code>{call.contract}</code> <code className="addr">{call.to}</code>
      <div>
        <strong>{call.functionName}</strong>(
        {call.args.map((a, i) => (
          <span key={a.name}>
            {i > 0 && ', '}
            {a.name} = <code>{a.value}</code>
            {/^\d+$/.test(a.value) && (a.name === 'value' || a.name === 'payment') && <span className="muted"> ({amountText(BigInt(a.value))})</span>}
          </span>
        ))}
        )
      </div>
    </li>
  )
}

export function MismatchList({ mismatches }: { mismatches: Mismatch[] }) {
  return (
    <div className="banner red" role="alert" data-testid="mismatch">
      <strong>Refused: the approval from the backend does not match the chain.</strong> No wallet prompt was opened. Reload and check again.
      <table>
        <thead><tr><th>Field</th><th>Backend sent</th><th>Chain / address book</th></tr></thead>
        <tbody>
          {mismatches.map((m) => (
            <tr key={m.field}><td>{m.field}</td><td><code>{inert(m.backend, 300)}</code></td><td><code>{m.chain}</code></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
