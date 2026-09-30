import { PaymentItem } from '../types/index.js';
import {
  formatCurrency,
  formatDate,
  getStatusBadgeClass,
  renderEmptyState,
} from '../components/ui-helpers.js';

export class PaymentsPage {
  public static render(payments: PaymentItem[], total: number, page = 1, limit = 20): string {
    const totalPages = Math.ceil(total / limit) || 1;

    return `
      <div class="page-container">
        <div class="page-header">
          <div>
            <h1 class="page-title">Authoritative Payments Ledger</h1>
            <p class="page-subtitle">Milestones 2 & 4 — Search, inspect, and track double-entry payment lifecycles</p>
          </div>
          <button class="btn btn-primary" onclick="openCreatePaymentModal()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            Create Test Payment
          </button>
        </div>

        <!-- Filter Bar -->
        <div class="filter-bar">
          <div>
            <span class="filter-label">Search:</span>
            <input id="pay-search-input" class="filter-input mono" type="text" placeholder="Search payment ID or customer" onkeyup="if(event.key==='Enter') fetchPayments()" />
          </div>
          <div>
            <span class="filter-label">Status:</span>
            <select id="pay-filter-status" class="filter-select" onchange="fetchPayments()">
              <option value="">All Statuses</option>
              <option value="CREATED">CREATED</option>
              <option value="PENDING">PENDING</option>
              <option value="AUTHORIZED">AUTHORIZED</option>
              <option value="CAPTURED">CAPTURED</option>
              <option value="PARTIALLY_REFUNDED">PARTIALLY_REFUNDED</option>
              <option value="REFUNDED">REFUNDED</option>
              <option value="SETTLED">SETTLED</option>
              <option value="FAILED">FAILED</option>
              <option value="CANCELLED">CANCELLED</option>
            </select>
          </div>
          <div>
            <span class="filter-label">Currency:</span>
            <select id="pay-filter-currency" class="filter-select" onchange="fetchPayments()">
              <option value="">All Currencies</option>
              <option value="INR">INR</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
          </div>
          <button class="btn" onclick="fetchPayments()">Apply Filters</button>
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Payment ID</th>
                <th>Amount</th>
                <th>Captured</th>
                <th>Refunded</th>
                <th>Status</th>
                <th>Created At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${payments.length > 0 ? payments.map((p) => `
                <tr style="cursor: pointer;" onclick="navigateTo('#/payments/${p.id}')">
                  <td class="mono font-bold">${p.id}</td>
                  <td class="mono font-bold">${formatCurrency(p.amountMinor, p.currency)}</td>
                  <td class="mono text-emerald">${formatCurrency(p.capturedAmountMinor, p.currency)}</td>
                  <td class="mono text-amber">${formatCurrency(p.refundedAmountMinor, p.currency)}</td>
                  <td><span class="badge ${getStatusBadgeClass(p.status)}">${p.status}</span></td>
                  <td class="mono">${formatDate(p.createdAt)}</td>
                  <td>
                    <button class="btn btn-sm" onclick="event.stopPropagation(); navigateTo('#/payments/${p.id}')">Details</button>
                  </td>
                </tr>
              `).join('') : `<tr><td colspan="7">${renderEmptyState('No payments found matching criteria.')}</td></tr>`}
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 1rem; font-size: 0.85rem; color: #94a3b8;">
          <div>Showing ${payments.length} of ${total} payments</div>
          <div style="display: flex; gap: 0.5rem;">
            <button class="btn btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="fetchPayments(${page - 1})">Previous</button>
            <span class="mono" style="padding: 0.25rem 0.5rem;">Page ${page} of ${totalPages}</span>
            <button class="btn btn-sm" ${page >= totalPages ? 'disabled' : ''} onclick="fetchPayments(${page + 1})">Next</button>
          </div>
        </div>
      </div>
    `;
  }
}
