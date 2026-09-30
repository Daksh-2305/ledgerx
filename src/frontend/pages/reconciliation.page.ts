import { ReconciliationRunItem, ReconciliationRecordItem } from '../types/index.js';
import {
  formatCurrency,
  formatDate,
  getStatusBadgeClass,
  renderEmptyState,
} from '../components/ui-helpers.js';

export class ReconciliationPage {
  public static renderRuns(runs: ReconciliationRunItem[]): string {
    return `
      <div class="page-container">
        <div class="page-header">
          <div>
            <h1 class="page-title">Automated Financial Reconciliation</h1>
            <p class="page-subtitle">Milestone 9 — High-integrity matching between internal ledger and external provider records</p>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <button class="btn btn-primary" onclick="openCreateRunModal()">
              Trigger Reconciliation Run
            </button>
            <button class="btn" onclick="generateTestDatasetAndRun()">
              ⚡ Simulate & Reconcile (100 tx)
            </button>
          </div>
        </div>

        <!-- Navigation Tabs -->
        <div class="tabs-nav" style="display: flex; gap: 1rem; border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 1.5rem;">
          <button class="tab-btn active" onclick="switchReconTab('runs')">Reconciliation Runs</button>
          <button class="tab-btn" onclick="switchReconTab('discrepancies')">Open Discrepancies</button>
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Run Reference</th>
                <th>Provider</th>
                <th>Period</th>
                <th>Status</th>
                <th>Internal</th>
                <th>External</th>
                <th>Matched</th>
                <th>Mismatches</th>
                <th>Missing</th>
                <th>Duplicates</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${runs.length > 0 ? runs.map((r) => `
                <tr style="cursor: pointer;" onclick="navigateTo('#/reconciliation/runs/${r.id}')">
                  <td class="mono font-bold">${r.runReference}</td>
                  <td><span class="badge badge-secondary">${r.provider}</span></td>
                  <td class="mono" style="font-size: 0.75rem;">${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}</td>
                  <td><span class="badge ${getStatusBadgeClass(r.status)}">${r.status}</span></td>
                  <td class="mono">${r.totalInternalRecords}</td>
                  <td class="mono">${r.totalExternalRecords}</td>
                  <td class="mono text-emerald font-bold">${r.matchedCount}</td>
                  <td class="mono ${r.mismatchCount > 0 ? 'text-rose font-bold' : ''}">${r.mismatchCount}</td>
                  <td class="mono ${r.missingInternalCount + r.missingExternalCount > 0 ? 'text-amber' : ''}">
                    ${r.missingInternalCount + r.missingExternalCount}
                  </td>
                  <td class="mono ${r.duplicateCount > 0 ? 'text-purple' : ''}">${r.duplicateCount}</td>
                  <td>
                    <button class="btn btn-sm" onclick="event.stopPropagation(); navigateTo('#/reconciliation/runs/${r.id}')">View</button>
                  </td>
                </tr>
              `).join('') : `<tr><td colspan="11">${renderEmptyState('No reconciliation runs recorded yet.')}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  public static renderRunDetail(run: ReconciliationRunItem, records: ReconciliationRecordItem[]): string {
    return `
      <div class="page-container">
        <div class="breadcrumb">
          <a href="#/reconciliation">← Back to Reconciliation</a>
        </div>

        <div class="page-header" style="margin-top: 0.75rem;">
          <div>
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <h1 class="page-title mono">Run: ${run.runReference}</h1>
              <span class="badge ${getStatusBadgeClass(run.status)}">${run.status}</span>
            </div>
            <p class="page-subtitle">Provider: ${run.provider} | Period: ${formatDate(run.periodStart)} to ${formatDate(run.periodEnd)}</p>
          </div>
        </div>

        <div class="metrics-grid" style="grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 1.5rem;">
          <div class="metric-card">
            <div class="metric-label">Matched</div>
            <div class="metric-value mono text-emerald">${run.matchedCount}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Amount Mismatches</div>
            <div class="metric-value mono text-rose">${run.mismatchCount}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Missing Internal</div>
            <div class="metric-value mono text-amber">${run.missingInternalCount}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Missing External</div>
            <div class="metric-value mono text-amber">${run.missingExternalCount}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Duplicates</div>
            <div class="metric-value mono text-purple">${run.duplicateCount}</div>
          </div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom: 1rem;">Matched & Discrepancy Records (${records.length})</div>
          ${records.length > 0 ? `
            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Result</th>
                    <th>Status</th>
                    <th>Internal Ref</th>
                    <th>External Ref</th>
                    <th>Difference</th>
                    <th>Reason</th>
                    <th>Resolution</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${records.map((rec) => `
                    <tr>
                      <td><span class="badge ${getStatusBadgeClass(rec.result)}">${rec.result}</span></td>
                      <td><span class="badge ${getStatusBadgeClass(rec.status)}">${rec.status}</span></td>
                      <td class="mono font-bold">${rec.internalReference || '—'}</td>
                      <td class="mono">${rec.externalReference || '—'}</td>
                      <td class="mono ${rec.differenceMinor > 0 ? 'text-rose' : ''}">
                        ${rec.differenceMinor ? formatCurrency(rec.differenceMinor) : '₹0.00'}
                      </td>
                      <td style="font-size: 0.8rem; color: #94a3b8;">${rec.reason || '—'}</td>
                      <td style="font-size: 0.8rem;">${rec.resolutionNotes || '—'}</td>
                      <td>
                        ${rec.status === 'OPEN' || rec.status === 'INVESTIGATING' ? `
                          <div style="display: flex; gap: 0.25rem;">
                            <button class="btn btn-sm" onclick="openResolveModal('${rec.id}', 'RESOLVE')">Resolve</button>
                            <button class="btn btn-sm" style="color: #cbd5e1;" onclick="openResolveModal('${rec.id}', 'WAIVE')">Waive</button>
                          </div>
                        ` : `<span style="font-size: 0.75rem; color: #10b981;">Resolved</span>`}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : renderEmptyState('No records in this reconciliation run.')}
        </div>
      </div>
    `;
  }
}
