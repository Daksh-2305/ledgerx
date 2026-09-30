import { SystemHealthData } from '../types/index.js';
import { getStatusBadgeClass, renderLoadingState, renderErrorState } from '../components/ui-helpers.js';

export class SystemHealthPage {
  public static render(health: SystemHealthData | null, loading = false, error: string | null = null): string {
    if (loading) return renderLoadingState('Checking infrastructure readiness...');
    if (error) return renderErrorState(error, 'refreshSystemHealth');
    if (!health) return renderErrorState('System health data unavailable.');

    return `
      <div class="page-container">
        <div class="page-header">
          <div>
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <h1 class="page-title">System Infrastructure & Health</h1>
              <span class="badge ${getStatusBadgeClass(health.status)}">${health.status}</span>
            </div>
            <p class="page-subtitle">PostgreSQL, Redis, Kafka, and Worker status monitoring</p>
          </div>
          <button class="btn btn-primary" onclick="refreshSystemHealth()">Refresh Status</button>
        </div>

        <div class="accounts-grid" style="grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); margin-bottom: 2rem;">
          <div class="card">
            <div class="card-title">PostgreSQL Database</div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.75rem;">
              <span class="mono">${health.dependencies.database.connected ? 'Connected' : 'Disconnected'}</span>
              <span class="badge ${health.dependencies.database.connected ? 'badge-success' : 'badge-danger'}">
                ${health.dependencies.database.connected ? 'Healthy' : 'Unavailable'}
              </span>
            </div>
            <div class="metric-meta" style="margin-top: 0.5rem;">
              Latency: ${health.dependencies.database.latencyMs ?? 0}ms (Authoritative Financial Store)
            </div>
          </div>

          <div class="card">
            <div class="card-title">Redis Cache & Locks</div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.75rem;">
              <span class="mono">${health.dependencies.redis.connected ? 'Connected' : 'Disconnected'}</span>
              <span class="badge ${health.dependencies.redis.connected ? 'badge-success' : 'badge-warning'}">
                ${health.dependencies.redis.connected ? 'Healthy' : 'Degraded'}
              </span>
            </div>
            <div class="metric-meta" style="margin-top: 0.5rem;">
              Latency: ${health.dependencies.redis.latencyMs ?? 0}ms (Idempotency & Rate Limiting)
            </div>
          </div>

          <div class="card">
            <div class="card-title">Kafka Event Broker</div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.75rem;">
              <span class="mono">${health.dependencies.kafka.connected ? 'Connected' : 'Disconnected'}</span>
              <span class="badge ${health.dependencies.kafka.connected ? 'badge-success' : 'badge-warning'}">
                ${health.dependencies.kafka.connected ? 'Healthy' : 'Degraded'}
              </span>
            </div>
            <div class="metric-meta" style="margin-top: 0.5rem;">
              Latency: ${health.dependencies.kafka.latencyMs ?? 0}ms (Outbox & Domain Events)
            </div>
          </div>

          <div class="card">
            <div class="card-title">Uptime & Service</div>
            <div class="mono font-bold" style="font-size: 1.4rem; margin-top: 0.75rem;">
              ${Math.floor(health.uptimeSeconds / 60)} min ${health.uptimeSeconds % 60}s
            </div>
            <div class="metric-meta" style="margin-top: 0.5rem;">Core Service: Active</div>
          </div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom: 1rem;">Component Metric Snapshots</div>
          <pre class="mono" style="background: rgba(0,0,0,0.4); padding: 1rem; border-radius: 8px; font-size: 0.8rem; overflow-x: auto;">
${JSON.stringify({ dependencies: health.dependencies, metrics: health.metrics }, null, 2)}
          </pre>
        </div>
      </div>
    `;
  }
}
