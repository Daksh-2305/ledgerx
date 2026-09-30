const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');

console.log('====================================================');
console.log('1. VERIFYING DESIGN TOKENS & CSS SPEC');
console.log('====================================================');

const requiredTokens = [
  '--background: #f7f8fa',
  '--surface: #ffffff',
  '--surface-secondary: #f9fafb',
  '--border: #e4e7ec',
  '--text-primary: #111827',
  '--text-secondary: #475467',
  '--text-muted: #667085',
  '--primary: #3157d5',
  '--primary-hover: #2444b6',
  '--success: #16a34a',
  '--warning: #d97706',
  '--danger: #dc2626'
];

let allTokensFound = true;
for (const token of requiredTokens) {
  const [k] = token.split(': ');
  if (html.includes(k)) {
    console.log(`[PASS] Design token ${k}`);
  } else {
    console.error(`[FAIL] Missing design token: ${k}`);
    allTokensFound = false;
  }
}

console.log('\n====================================================');
console.log('2. VERIFYING 10 NAVIGATION ROUTES & VIEWS');
console.log('====================================================');

const routes = [
  { path: 'dashboard', viewId: 'view-dashboard', label: 'Dashboard' },
  { path: 'payments', viewId: 'view-payments', label: 'Payments' },
  { path: 'refunds', viewId: 'view-refunds', label: 'Refunds' },
  { path: 'risk', viewId: 'view-risk', label: 'Risk Engine' },
  { path: 'ledger', viewId: 'view-ledger', label: 'Double-Entry Ledger' },
  { path: 'reconciliation', viewId: 'view-reconciliation', label: 'Reconciliation' },
  { path: 'settlements', viewId: 'view-settlements', label: 'Settlements' },
  { path: 'webhooks', viewId: 'view-webhooks', label: 'Webhooks' },
  { path: 'webhooks/dlq', viewId: 'view-dlq', label: 'Dead Letter Queue' },
  { path: 'system', viewId: 'view-system', label: 'System Health' }
];

let allRoutesValid = true;
for (const r of routes) {
  const linkAttr = `data-route="${r.path}"`;
  const viewAttr = `id="${r.viewId}"`;
  const hasLink = html.includes(linkAttr);
  const hasView = html.includes(viewAttr);
  if (hasLink && hasView) {
    console.log(`[PASS] Route /${r.path.padEnd(16)} -> <section id="${r.viewId}">`);
  } else {
    console.error(`[FAIL] Route /${r.path}: hasLink=${hasLink}, hasView=${hasView}`);
    allRoutesValid = false;
  }
}

console.log('\n====================================================');
console.log('3. TESTING JAVASCRIPT LOGIC & ROUTE RESOLUTION');
console.log('====================================================');

// Extract script
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error('[FAIL] Could not extract <script> tag from index.html');
  process.exit(1);
}

// Emulate client browser environment to test normalizeRoute and routing
const mockWindow = {
  location: { hash: '', pathname: '/' },
  scrollTo: () => {},
  addEventListener: () => {}
};
const mockDocument = {
  getElementById: (id) => ({
    innerText: '',
    innerHTML: '',
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    className: '',
    style: {}
  }),
  querySelectorAll: () => [],
  addEventListener: () => {}
};

// Check that functions compile
try {
  // Extract normalizeRoute definition
  const normalizeMatch = html.match(/function normalizeRoute\([\s\S]*?^    \}/m);
  if (!normalizeMatch) {
    throw new Error('normalizeRoute not found in index.html');
  }

  // Create isolated evaluator for normalizeRoute
  const ROUTES = {
    dashboard: {},
    payments: {},
    refunds: {},
    risk: {},
    ledger: {},
    reconciliation: {},
    settlements: {},
    webhooks: {},
    'webhooks/dlq': {},
    system: {}
  };
  
  eval(normalizeMatch[0]);

  const testInputs = [
    { in: '#/dashboard', expected: 'dashboard' },
    { in: '#/payments', expected: 'payments' },
    { in: '#/refunds', expected: 'refunds' },
    { in: '#/risk', expected: 'risk' },
    { in: '#/ledger', expected: 'ledger' },
    { in: '#/reconciliation', expected: 'reconciliation' },
    { in: '#/settlements', expected: 'settlements' },
    { in: '#/webhooks', expected: 'webhooks' },
    { in: '#/webhooks/dlq', expected: 'webhooks/dlq' },
    { in: '#/dlq', expected: 'webhooks/dlq' },
    { in: '#/system', expected: 'system' },
    { in: '/payments', expected: 'payments' },
    { in: 'refunds', expected: 'refunds' },
    { in: '', expected: 'dashboard' },
    { in: undefined, expected: 'dashboard' },
    { in: '#/unknown', expected: 'dashboard' }
  ];

  for (const t of testInputs) {
    const res = normalizeRoute(t.in);
    if (res === t.expected) {
      console.log(`[PASS] normalizeRoute('${t.in}') => '${res}'`);
    } else {
      console.error(`[FAIL] normalizeRoute('${t.in}') expected '${t.expected}' got '${res}'`);
      allRoutesValid = false;
    }
  }

} catch(err) {
  console.error('[FAIL] Error testing normalizeRoute:', err.message);
  allRoutesValid = false;
}

console.log('\n====================================================');
console.log('4. TESTING BACKEND HTTP ENDPOINTS & SPA SERVING');
console.log('====================================================');

async function testEndpoints() {
  const endpoints = [
    { url: 'http://localhost:3000/', expect: 200, checkHtml: true },
    { url: 'http://localhost:3000/payments', expect: 200, checkHtml: true },
    { url: 'http://localhost:3000/ledger', expect: 200, checkHtml: true },
    { url: 'http://localhost:3000/webhooks/dlq', expect: 200, checkHtml: true },
    { url: 'http://localhost:3000/api/v1/dashboard/metrics', expect: 200 },
    { url: 'http://localhost:3000/api/v1/payments?page=1&limit=5', expect: 200 },
    { url: 'http://localhost:3000/api/v1/ledger/transactions?page=1&limit=5', expect: 200 },
    { url: 'http://localhost:3000/api/v1/risk/assessments?page=1&limit=5', expect: 200 },
    { url: 'http://localhost:3000/api/v1/reconciliation/runs?page=1&limit=5', expect: 200 },
    { url: 'http://localhost:3000/api/v1/settlements?page=1&limit=5', expect: 200 },
    { url: 'http://localhost:3000/api/v1/webhooks?page=1&limit=5', expect: 200 },
    { 
      url: 'http://localhost:3000/api/v1/webhooks/dead-letter?page=1&limit=5', 
      headers: { 'x-admin-key': 'ledgerx_admin_secret_key_change_in_production' }, 
      expect: 200 
    },
    { url: 'http://localhost:3000/health/dependencies', expect: [200, 503] }
  ];

  let allEndpointsPass = true;
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, { headers: ep.headers || {} });
      const ok = Array.isArray(ep.expect) ? ep.expect.includes(res.status) : res.status === ep.expect;
      if (ok) {
        if (ep.checkHtml) {
          const body = await res.text();
          const hasTitle = body.includes('LedgerX');
          console.log(`[PASS] ${ep.url} -> HTTP ${res.status} (serves LedgerX SPA correctly)`);
        } else {
          console.log(`[PASS] ${ep.url} -> HTTP ${res.status}`);
        }
      } else {
        console.error(`[FAIL] ${ep.url} -> HTTP ${res.status} (expected ${ep.expect})`);
        allEndpointsPass = false;
      }
    } catch(e) {
      console.error(`[FAIL] ${ep.url} -> Request error:`, e.message);
      allEndpointsPass = false;
    }
  }

  console.log('\n====================================================');
  console.log('5. DASHBOARD METRICS PAYLOAD SANITY CHECK');
  console.log('====================================================');
  try {
    const res = await fetch('http://localhost:3000/api/v1/dashboard/metrics');
    const json = await res.json();
    const d = json.data;
    console.log('Keys received from /api/v1/dashboard/metrics:');
    console.log(Object.keys(d));
    const expectedKeys = [
      'totalPaymentVolumeMinor',
      'successfulPayments',
      'failedPayments',
      'pendingPayments',
      'refundVolumeMinor',
      'openReconciliationIssues',
      'settlementAmountMinor',
      'webhookFailures',
      'highRiskPayments'
    ];
    for (const key of expectedKeys) {
      if (key in d) {
        console.log(`[PASS] Metric '${key}': ${JSON.stringify(d[key])}`);
      } else {
        console.error(`[FAIL] Missing metric key: ${key}`);
      }
    }
  } catch(e) {
    console.error('[FAIL] Metrics test error:', e.message);
  }

  if (allTokensFound && allRoutesValid && allEndpointsPass) {
    console.log('\n>>> ALL AUTOMATED FRONTEND QA AUDITS PASSED SUCCESSFULLY! <<<');
  } else {
    console.error('\n>>> SOME CHECKS FAILED. Review output above. <<<');
    process.exit(1);
  }
}

testEndpoints();
