import { SettlementBatchItem, SettlementRecordItem } from '../types/index.js';
import {
  formatCurrency,
  formatDate,
  getStatusBadgeClass,
  renderEmptyState,
} from '../components/ui-helpers.js';

export class SettlementsPage {
  public static renderList(batches: SettlementBatchItem[], _total = 0): string {
    return `
      <div class="page-container">
        <div class="page-header">
          <div>
            <h1 class="page-title">Merchant Settlement Batches</h1>
            <p class="page-subtitle">Milestone 10 — Authoritative batch aggregation, invariant checks, and ledger clearance</p>
          </div>
          <button class="btn btn-primary" onclick="openCreateSettlementModal()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            Create Settlement Batch
          </button>
        </div>

        <!-- Filter Bar -->
        <div class="filter-bar">
          <div>
            <span class="filter-label">Status:</span>
            <select id="settle-filter-status" class="filter-select" onchange="fetchSettlements()">
              <option value="">All Statuses</option>
              <option value="PENDING">PENDING</option>
              <option value="PROCESSING">PROCESSING</option>
              <option value="RECONCILED">RECONCILED</option>
              <option value="READY">READY</option>
              <option value="PROCESSING_SETTLEMENT">PROCESSING_SETTLEMENT</option>
              <option value="SETTLED">SETTLED</option>
              <option value="FAILED">FAILED</option>
              <option value="CANCELLED">CANCELLED</option>
            </select>
          </div>
          <div>
            <span class="filter-label">Currency:</span>
            <select id="settle-filter-currency" class="filter-select" onchange="fetchSettlements()">
              <option value="">All Currencies</option>
              <option value="INR">INR</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </div>
          <button class="btn" onclick="fetchSettlements()">Refresh</button>
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Batch Reference</th>
                <th>Merchant</th>
                <th>Period</th>
                <th>Gross</th>
                <th>Refunds</th>
                <th>Fees</th>
                <th>Adjustments</th>
                <th>Net Settlement</th>
                <th>Records</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${batches.length > 0 ? batches.map((b) => `
                <tr style="cursor: pointer;" onclick="navigateTo('#/settlements/${b.id}')">
                  <td class="mono font-bold">${b.batchReference}</td>
                  <td class="mono" style="font-size: 0.8rem;">${b.merchantId.slice(0, 8)}...</td>
                  <td class="mono" style="font-size: 0.75rem;">${formatDate(b.periodStart)} – ${formatDate(b.periodEnd)}</td>
                  <td class="mono">${formatCurrency(b.grossAmountMinor, b.currency)}</td>
                  <td class="mono text-amber">${formatCurrency(b.refundAmountMinor, b.currency)}</td>
                  <td class="mono text-rose">${formatCurrency(b.feeAmountMinor, b.currency)}</td>
                  <td class="mono">${formatCurrency(b.adjustmentAmountMinor, b.currency)}</td>
                  <td class="mono font-bold text-emerald">${formatCurrency(b.netAmountMinor, b.currency)}</td>
                  <td class="mono">${b.recordCount}</td>
                  <td><span class="badge ${getStatusBadgeClass(b.status)}">${b.status}</span></td>
                  <td>
                    <button class="btn btn-sm" onclick="event.stopPropagation(); navigateTo('#/settlements/${b.id}')">View</button>
                  </td>
                </tr>
              `).join('') : `<tr><td colspan="11">${renderEmptyState('No settlement batches found.')}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  public static renderDetail(batch: SettlementBatchItem, records: SettlementRecordItem[]): string {
    return `
      <div class="page-container">
        <div class="breadcrumb">
          <a href="#/settlements">← Back to Settlement Batches</a>
        </div>

        <div class="page-header" style="margin-top: 0.75rem;">
          <div>
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <h1 class="page-title mono">Batch: ${batch.batchReference}</h1>
              <span class="badge ${getStatusBadgeClass(batch.status)}">${batch.status}</span>
            </div>
            <p class="page-subtitle">Period: ${formatDate(batch.periodStart)} to ${formatDate(batch.periodEnd)}</p>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            ${batch.status === 'PENDING' ? `
              <button class="btn btn-primary" onclick="triggerProcessBatch('${batch.id}')">Process Calculations</button>
            ` : ''}
            ${batch.status === 'READY' ? `
              <button class="btn btn-primary" onclick="triggerExecuteSettlement('${batch.id}')">Execute Payout & Post Ledger</button>
            ` : ''}
            ${['PENDING', 'READY'].includes(batch.status) ? `
              <button class="btn btn-danger" onclick="triggerCancelSettlement('${batch.id}')">Cancel Batch</button>
            ` : ''}
          </div>
        </div>

        <!-- Section 1: Financial Calculation Breakdown (Section 4 & 30) -->
        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="card-title">Authoritative Financial Calculation</div>
          <div class="calculation-box" style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 1.25rem; font-family: var(--font-mono); margin-top: 1rem;">
            <div style="display: flex; justify-content: space-between; padding: 0.35rem 0;">
              <span>Gross Captured Payments:</span>
              <span class="font-bold">${formatCurrency(batch.grossAmountMinor, batch.currency)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 0.35rem 0; color: #f59e0b;">
              <span>- Refunds (Compensating):</span>
              <span>- ${formatCurrency(batch.refundAmountMinor, batch.currency)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 0.35rem 0; color: #fb7185;">
              <span>- Platform MDR Fees (2.00%):</span>
              <span>- ${formatCurrency(batch.feeAmountMinor, batch.currency)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 0.35rem 0;">
              <span>+/- Direct Adjustments:</span>
              <span>${batch.adjustmentAmountMinor >= 0 ? '+' : ''}${formatCurrency(batch.adjustmentAmountMinor, batch.currency)}</span>
            </div>
            <div style="border-top: 1px dashed rgba(255,255,255,0.2); margin-top: 0.5rem; padding-top: 0.75rem; display: flex; justify-content: space-between; font-size: 1.15rem; color: #34d399;" class="font-bold">
              <span>= Net Settlement Amount:</span>
              <span>${formatCurrency(batch.netAmountMinor, batch.currency)}</span>
            </div>
          </div>

          <div style="display: flex; gap: 2rem; margin-top: 1.25rem; font-size: 0.85rem;">
            <div><span class="field-label">Records Count:</span> <span class="mono font-bold">${batch.recordCount}</span></div>
            <div><span class="field-label">Ledger Transaction ID:</span> <span class="mono font-bold">${batch.ledgerTransactionId || 'Pending settlement execution'}</span></div>
            <div><span class="field-label">Completed At:</span> <span class="mono font-bold">${formatDate(batch.completedAt)}</span></div>
          </div>
        </div>

        <!-- Section 2: Individual Settlement Records -->
        <div class="card">
          <div class="card-title" style="margin-bottom: 1rem;">Individual Settlement Records (${records.length})</div>
          ${records.length > 0 ? `
            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Record ID</th>
                    <th>Payment ID</th>
                    <th>Gross</th>
                    <th>Refund</th>
                    <th>Fee</th>
                    <th>Net Amount</th>
                    <th>Status</th>
                    <th>Exclusion / Notes</th>
                  </tr>
                </thead>
                <tbody>
                  ${records.map((r) => `
                    <tr>
                      <td class="mono" style="font-size: 0.8rem;">${r.id.slice(0, 8)}...</td>
                      <td class="mono font-bold"><a href="#/payments/${r.paymentId}">${r.paymentId.slice(0, 8)}...</a></td>
                      <td class="mono">${formatCurrency(r.grossAmountMinor, r.currency)}</td>
                      <td class="mono text-amber">${formatCurrency(r.refundAmountMinor, r.currency)}</td>
                      <td class="mono text-rose">${formatCurrency(r.feeAmountMinor, r.currency)}</td>
                      <td class="mono font-bold text-emerald">${formatCurrency(r.netAmountMinor, r.currency)}</td>
                      <td><span class="badge ${getStatusBadgeClass(r.status)}">${r.status}</span></td>
                      <td style="font-size: 0.8rem; color: ${r.status === 'EXCLUDED' ? '#fb7185' : 'inherit'};">${r.errorMessage || '—'}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : renderEmptyState('No individual records in this batch.')}
        </div>
      </div>
    `;
  }
}
