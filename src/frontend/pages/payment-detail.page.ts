import {
  PaymentItem,
  RefundItem,
  RiskAssessmentItem,
  LedgerTransactionItem,
  WebhookEventItem,
} from '../types/index.js';
import { PaymentTimelineBuilder } from '../components/timeline.js';
import {
  formatCurrency,
  formatDate,
  getStatusBadgeClass,
  renderEmptyState,
} from '../components/ui-helpers.js';

export interface PaymentStoryData {
  payment: PaymentItem;
  refunds: RefundItem[];
  risk: RiskAssessmentItem | null;
  ledgerTransactions: LedgerTransactionItem[];
  webhooks: WebhookEventItem[];
}

export class PaymentDetailPage {
  public static render(story: PaymentStoryData): string {
    const { payment, refunds, risk, ledgerTransactions, webhooks } = story;
    const timeline = PaymentTimelineBuilder.buildTimeline(payment);

    return `
      <div class="page-container">
        <div class="breadcrumb">
          <a href="#/payments">← Back to Payments</a>
        </div>

        <div class="page-header" style="margin-top: 0.75rem;">
          <div>
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <h1 class="page-title mono" style="font-size: 1.4rem;">Payment: ${payment.id}</h1>
              <span class="badge ${getStatusBadgeClass(payment.status)}">${payment.status}</span>
            </div>
            <p class="page-subtitle">Authoritative ledger history and complete financial lifecycle</p>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            ${payment.status === 'CAPTURED' ? `
              <button class="btn btn-primary" onclick="openRefundModal('${payment.id}', ${payment.capturedAmountMinor - payment.refundedAmountMinor}, '${payment.currency}')">
                Issue Refund
              </button>
            ` : ''}
          </div>
        </div>

        <!-- Metadata Summary Card -->
        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="info-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
            <div>
              <div class="field-label">Merchant ID</div>
              <div class="field-value mono">${payment.merchantId}</div>
            </div>
            <div>
              <div class="field-label">Customer ID</div>
              <div class="field-value mono">${payment.customerId}</div>
            </div>
            <div>
              <div class="field-label">Authorized Amount</div>
              <div class="field-value mono font-bold">${formatCurrency(payment.amountMinor, payment.currency)}</div>
            </div>
            <div>
              <div class="field-label">Captured Amount</div>
              <div class="field-value mono text-emerald">${formatCurrency(payment.capturedAmountMinor, payment.currency)}</div>
            </div>
            <div>
              <div class="field-label">Refunded Amount</div>
              <div class="field-value mono text-amber">${formatCurrency(payment.refundedAmountMinor, payment.currency)}</div>
            </div>
            <div>
              <div class="field-label">Created At</div>
              <div class="field-value mono">${formatDate(payment.createdAt)}</div>
            </div>
            <div>
              <div class="field-label">Last Updated</div>
              <div class="field-value mono">${formatDate(payment.updatedAt)}</div>
            </div>
          </div>
        </div>

        <!-- Section 1: Payment Lifecycle Timeline -->
        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="card-title" style="margin-bottom: 1rem;">Payment Lifecycle Timeline</div>
          <div class="timeline-container" style="display: flex; align-items: center; justify-content: space-between; position: relative;">
            ${timeline.map((step, idx) => `
              <div class="timeline-step ${step.status}" style="display: flex; flex-direction: column; align-items: center; flex: 1; text-align: center; position: relative;">
                <div class="timeline-dot ${step.status}" style="width: 14px; height: 14px; border-radius: 50%; margin-bottom: 0.5rem; background: ${step.status === 'completed' ? '#10b981' : step.status === 'failed' ? '#f43f5e' : step.status === 'current' ? '#3b82f6' : '#475569'};"></div>
                <div class="timeline-label font-bold" style="font-size: 0.85rem;">${step.step}</div>
                <div class="timeline-timestamp mono" style="font-size: 0.725rem; color: #94a3b8;">${formatDate(step.timestamp)}</div>
                <div class="timeline-desc" style="font-size: 0.75rem; color: #64748b; margin-top: 0.25rem;">${step.description}</div>
              </div>
              ${idx < timeline.length - 1 ? `<div class="timeline-line" style="flex: 1; height: 2px; background: rgba(255,255,255,0.1); margin-top: -2.5rem;"></div>` : ''}
            `).join('')}
          </div>
        </div>

        <!-- Section 2: Risk Assessment -->
        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="card-title" style="margin-bottom: 1rem;">Risk Assessment Engine</div>
          ${risk ? `
            <div style="display: flex; gap: 2rem; align-items: center;">
              <div>
                <span class="field-label">Risk Score</span>
                <div class="mono font-bold" style="font-size: 2rem; color: ${risk.riskScore >= 50 ? '#f43f5e' : '#10b981'};">${risk.riskScore}/100</div>
              </div>
              <div>
                <span class="field-label">Risk Level</span>
                <div><span class="badge ${getStatusBadgeClass(risk.riskLevel)}">${risk.riskLevel}</span></div>
              </div>
              <div>
                <span class="field-label">Decision</span>
                <div><span class="badge ${getStatusBadgeClass(risk.decision)}">${risk.decision}</span></div>
              </div>
              <div>
                <span class="field-label">Model Version</span>
                <div class="mono">${risk.modelVersion}</div>
              </div>
            </div>
            ${risk.triggeredRules && risk.triggeredRules.length > 0 ? `
              <div style="margin-top: 1rem;">
                <span class="field-label">Triggered Rules:</span>
                <div style="display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.5rem;">
                  ${risk.triggeredRules.map((r) => `
                    <div class="rule-chip" style="background: rgba(255,255,255,0.04); padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.8rem;">
                      <span class="mono font-bold text-amber">${r.ruleName}</span> (+${r.score} pts): ${r.description}
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : '<div style="margin-top: 0.75rem; font-size: 0.825rem; color: #10b981;">No risk anomalies triggered.</div>'}
          ` : renderEmptyState('No risk assessment recorded for this payment.')}
        </div>

        <!-- Section 3: Ledger Transactions -->
        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="card-title" style="margin-bottom: 1rem;">Double-Entry Ledger Postings</div>
          ${ledgerTransactions.length > 0 ? `
            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Transaction ID</th>
                    <th>Type</th>
                    <th>Entries (Balanced Debits = Credits)</th>
                  </tr>
                </thead>
                <tbody>
                  ${ledgerTransactions.map((tx) => `
                    <tr>
                      <td class="mono">${formatDate(tx.postedAt)}</td>
                      <td class="mono font-bold">${tx.id}</td>
                      <td><span class="badge badge-secondary">${tx.transactionType}</span></td>
                      <td>
                        <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                          ${tx.entries.map((e) => `
                            <div class="mono" style="font-size: 0.8rem; color: ${e.entryType === 'DEBIT' ? '#60a5fa' : '#34d399'};">
                              ${e.entryType}: ${e.accountCode || e.accountId} (${formatCurrency(e.amountMinor, e.currency)})
                            </div>
                          `).join('')}
                        </div>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : renderEmptyState('No ledger postings recorded yet.')}
        </div>

        <!-- Section 4: Refunds -->
        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="card-title" style="margin-bottom: 1rem;">Refund Operations</div>
          ${refunds.length > 0 ? `
            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Refund ID</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Reason</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  ${refunds.map((r) => `
                    <tr>
                      <td class="mono">${r.id}</td>
                      <td class="mono font-bold">${formatCurrency(r.amountMinor, r.currency)}</td>
                      <td><span class="badge ${getStatusBadgeClass(r.status)}">${r.status}</span></td>
                      <td>${r.reason || '—'}</td>
                      <td class="mono">${formatDate(r.createdAt)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : renderEmptyState('No refunds issued for this payment.')}
        </div>

        <!-- Section 5: Webhooks & Events -->
        <div class="card">
          <div class="card-title" style="margin-bottom: 1rem;">Webhook Events & Delivery History</div>
          ${webhooks.length > 0 ? `
            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Event ID</th>
                    <th>Event Type</th>
                    <th>Provider</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Received At</th>
                  </tr>
                </thead>
                <tbody>
                  ${webhooks.map((w) => `
                    <tr>
                      <td class="mono">${w.eventId}</td>
                      <td class="mono font-bold">${w.eventType}</td>
                      <td>${w.provider}</td>
                      <td><span class="badge ${getStatusBadgeClass(w.status)}">${w.status}</span></td>
                      <td class="mono">${w.attempts}/${w.maxAttempts}</td>
                      <td class="mono">${formatDate(w.receivedAt)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : renderEmptyState('No webhooks ingested for this payment ID.')}
        </div>
      </div>
    `;
  }
}
