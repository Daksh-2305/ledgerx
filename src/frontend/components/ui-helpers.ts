import { formatMinorToMajor } from '../../common/money.js';

export function formatCurrency(amountMinor: number, currency: string = 'INR'): string {
  return formatMinorToMajor(amountMinor, currency);
}

export function formatDate(isoString?: string | null): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

export function getStatusBadgeClass(status: string): string {
  switch (status.toUpperCase()) {
    case 'CAPTURED':
    case 'SETTLED':
    case 'COMPLETED':
    case 'MATCHED':
    case 'ALLOW':
    case 'RESOLVED':
    case 'UP':
    case 'HEALTHY':
    case 'READY':
      return 'badge-success';

    case 'PENDING':
    case 'PROCESSING':
    case 'PROCESSING_SETTLEMENT':
    case 'RECONCILED':
    case 'INVESTIGATING':
    case 'REVIEW':
    case 'RETRY_PENDING':
    case 'DEGRADED':
      return 'badge-warning';

    case 'FAILED':
    case 'CANCELLED':
    case 'DEAD_LETTERED':
    case 'BLOCK':
    case 'AMOUNT_MISMATCH':
    case 'STATUS_MISMATCH':
    case 'CURRENCY_MISMATCH':
    case 'MISSING_INTERNAL':
    case 'MISSING_EXTERNAL':
    case 'DUPLICATE_EXTERNAL':
    case 'DOWN':
    case 'UNHEALTHY':
      return 'badge-danger';

    case 'PARTIALLY_REFUNDED':
    case 'REFUNDED':
    case 'WAIVED':
      return 'badge-info';

    default:
      return 'badge-secondary';
  }
}

export function renderEmptyState(message: string, icon = '📂'): string {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      <div class="empty-state-text">${message}</div>
    </div>
  `;
}

export function renderLoadingState(message = 'Loading authoritative financial data...'): string {
  return `
    <div class="loading-state">
      <div class="spinner"></div>
      <div class="loading-state-text">${message}</div>
    </div>
  `;
}

export function renderErrorState(message: string, onRetryFn?: string): string {
  return `
    <div class="error-state">
      <div class="error-state-icon">⚠️</div>
      <div class="error-state-text">${message}</div>
      ${onRetryFn ? `<button class="btn btn-sm" onclick="${onRetryFn}()">Retry</button>` : ''}
    </div>
  `;
}
