import { DashboardMetrics } from '../types/index.js';
import { formatCurrency, renderLoadingState, renderErrorState } from '../components/ui-helpers.js';

export class DashboardPage {
  public static render(metrics: DashboardMetrics | null, loading = false, error: string | null = null): string {
    if (loading) return renderLoadingState('Loading dashboard metrics from LedgerX core...');
    if (error) return renderErrorState(error, 'refreshDashboard');
    if (!metrics) return renderErrorState('No metrics available.');

    return `
      <div class="page-container">
        <div class="page-header">
          <div>
            <h1 class="page-title">Executive Production Dashboard</h1>
            <p class="page-subtitle">Real-time financial volume, ledger integrity, risk assessments, and settlement status</p>
          </div>
          <button class="btn btn-primary" onclick="refreshDashboard()">Refresh Metrics</button>
        </div>

        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-label">Total Payment Volume</div>
            <div class="metric-value mono">${metrics.totalPaymentVolumeFormatted}</div>
            <div class="metric-meta">${metrics.totalPayments} total transactions recorded</div>
          </div>

          <div class="metric-card">
            <div class="metric-label">Successful Payments</div>
            <div class="metric-value mono text-emerald">${metrics.successfulPayments}</div>
            <div class="metric-meta">Captured or Settled status</div>
          </div>

          <div class="metric-card">
            <div class="metric-label">Failed / Cancelled</div>
            <div class="metric-value mono text-rose">${metrics.failedPayments}</div>
            <div class="metric-meta">Zero financial leakage</div>
          </div>

          <div class="metric-card">
            <div class="metric-label">Refund Volume</div>
            <div class="metric-value mono text-amber">${metrics.refundVolumeFormatted}</div>
            <div class="metric-meta">Compensating double-entry journal</div>
          </div>

          <div class="metric-card">
            <div class="metric-label">Pending Payments</div>
            <div class="metric-value mono text-blue">${metrics.pendingPayments}</div>
            <div class="metric-meta">Created or Pending processing</div>
          </div>

          <div class="metric-card">
            <div class="metric-label">Open Reconciliation Issues</div>
            <div class="metric-value mono text-rose">${metrics.openReconciliationIssues}</div>
            <div class="metric-meta">Mismatches awaiting operator review</div>
          </div>

          <div class="metric-card">
            <div class="metric-label">Total Settled Volume</div>
            <div class="metric-value mono text-emerald">${metrics.settlementAmountFormatted}</div>
            <div class="metric-meta">Cleared via Settlement Engine</div>
          </div>

          <div class="metric-card">
            <div class="metric-label">Webhook Failures</div>
            <div class="metric-value mono text-rose">${metrics.webhookFailures}</div>
            <div class="metric-meta">Failed or Dead-Lettered webhooks</div>
          </div>

          <div class="metric-card">
            <div class="metric-label">High-Risk Payments</div>
            <div class="metric-value mono text-purple">${metrics.highRiskPayments}</div>
            <div class="metric-meta">Risk score >= 50 (High or Critical)</div>
          </div>
        </div>

        <!-- Volume Chart & Status Breakdown -->
        <div class="dashboard-charts-grid" style="display: grid; grid-template-columns: 2fr 1fr; gap: 1.5rem; margin-top: 1.5rem;">
          <div class="card">
            <div class="card-title">Recent Payment Volume Activity</div>
            <div class="chart-container" style="min-height: 240px; display: flex; align-items: flex-end; gap: 0.5rem; padding-top: 1rem;">
              ${metrics.volumeTrend.slice(0, 15).map((item) => {
                const heightPercent = Math.max(15, Math.min(100, Math.round((item.amount / 100000) * 100)));
                return `
                  <div class="bar-col" style="flex: 1; display: flex; flex-direction: column; align-items: center; gap: 0.25rem;">
                    <div class="bar" style="width: 100%; height: ${heightPercent}px; background: linear-gradient(to top, #3b82f6, #6366f1); border-radius: 4px;" title="${formatCurrency(item.amount)} - ${item.status}"></div>
                    <span class="mono" style="font-size: 0.65rem; color: #94a3b8;">${new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <div class="card">
            <div class="card-title">Payment Status Distribution</div>
            <div class="distribution-list" style="margin-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">
              ${Object.entries(metrics.statusDistribution).map(([status, count]) => `
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem;">
                  <span class="mono">${status}</span>
                  <span class="mono font-bold">${count}</span>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
