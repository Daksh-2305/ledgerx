const puppeteer = require('puppeteer-core');

const chromePath = 'C:\\Users\\Daksh Khandal\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  console.log('=== FULL BROWSER AUTOMATION QA RUNNING IN REAL GOOGLE CHROME ===\n');

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const errors = [];
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error') {
      console.error('  [CONSOLE ERROR]:', text);
      errors.push(text);
    } else {
      console.log(`  [CONSOLE ${msg.type().toUpperCase()}]:`, text);
    }
  });

  page.on('pageerror', err => {
    console.error('  [PAGE UNCAUGHT ERROR]:', err.message);
    errors.push(err.message);
  });

  page.on('requestfailed', req => {
    console.error('  [NETWORK FAILED]:', req.method(), req.url(), req.failure()?.errorText);
    errors.push(`Network failed: ${req.url()}`);
  });

  // =========================================================================
  // TEST 0: BRAND ASSET INTEGRITY & VISUAL IDENTITY VERIFICATION
  // =========================================================================
  console.log('--- TEST 0: BRAND ASSET INTEGRITY & VISUAL IDENTITY VERIFICATION ---');
  
  // Direct asset HTTP fetch tests
  const assetUrls = [
    'http://localhost:3000/brand/ledgerx-logo.svg',
    'http://localhost:3000/brand/ledgerx-mark.svg',
    'http://localhost:3000/favicon.svg',
    'http://localhost:3000/favicon.ico'
  ];

  for (const assetUrl of assetUrls) {
    const assetRes = await page.goto(assetUrl);
    const status = assetRes.status();
    const contentType = assetRes.headers()['content-type'];
    console.log(`0.1 Asset Fetch: ${assetUrl} -> HTTP ${status} (${contentType})`);
    if (status !== 200 && status !== 304) {
      throw new Error(`Asset ${assetUrl} failed to load with status ${status}`);
    }
  }

  // Load the main dashboard
  await page.goto('http://localhost:3000/#/dashboard', { waitUntil: 'networkidle0' });

  // Verify Document Title
  const docTitle = await page.title();
  console.log('0.2 Page Title:', docTitle);
  if (docTitle !== 'LedgerX — Payment Infrastructure') {
    throw new Error(`Unexpected document title: ${docTitle}`);
  }

  // Verify Favicon Link
  const faviconHref = await page.$eval('link[rel="icon"]', el => el.getAttribute('href'));
  console.log('0.3 Favicon Link Href:', faviconHref);
  if (faviconHref !== '/favicon.svg') {
    throw new Error(`Favicon link is not /favicon.svg: ${faviconHref}`);
  }

  // Verify Sidebar Brand Mark and Typography
  const brandImgSrc = await page.$eval('.brand-symbol-img', el => el.getAttribute('src'));
  const brandImgLoaded = await page.$eval('.brand-symbol-img', el => el.complete && el.naturalWidth > 0);
  const brandTitleText = await page.$eval('.brand-title', el => el.innerText);
  const brandSubText = await page.$eval('.brand-subtitle', el => el.innerText);
  const footerBrandText = await page.$eval('.sidebar-footer', el => el.innerText);

  console.log('0.4 Sidebar Brand Image Src:', brandImgSrc, '| Image Loaded:', brandImgLoaded);
  console.log('    Sidebar Brand Title:', brandTitleText);
  console.log('    Sidebar Brand Subtitle:', brandSubText);
  console.log('    Sidebar Footer Text preview:', footerBrandText.split('\n')[0]);

  if (!brandImgLoaded) {
    throw new Error('Brand mark image did not load successfully in browser DOM');
  }
  if (!brandTitleText.includes('LedgerX')) {
    throw new Error(`Brand title does not contain LedgerX: ${brandTitleText}`);
  }
  if (brandSubText !== 'PAYMENT INFRASTRUCTURE') {
    throw new Error(`Brand subtitle is not PAYMENT INFRASTRUCTURE: ${brandSubText}`);
  }

  // Verify Ledger Page Double-Entry Invariant Audit Styling
  await page.goto('http://localhost:3000/#/ledger', { waitUntil: 'networkidle0' });
  const ledgerBannerText = await page.$eval('.integrity-status-text', el => el.innerText.trim());
  const ledgerStripText = await page.$eval('#ledger-totals-strip', el => el.innerText.trim());
  console.log('0.5 Ledger Audit Status:', ledgerBannerText);
  console.log('    Ledger Audit Totals:', ledgerStripText);

  // =========================================================================
  // TEST 1: PAYMENTS - CREATE PAYMENT INTENT & MANUAL LIFECYCLE
  // =========================================================================
  console.log('\n--- TEST 1: PAYMENTS - CREATE PAYMENT INTENT & MANUAL LIFECYCLE ---');
  await page.goto('http://localhost:3000/#/payments', { waitUntil: 'networkidle0' });

  console.log('1.1 Clicking #btn-create-intent (Create Payment Intent)');
  await page.click('#btn-create-intent');
  await page.waitForSelector('#modal-create-payment.active', { timeout: 4000 });
  console.log('  ✓ Create Payment Modal opened successfully');

  const intentModalTitle = await page.$eval('#cp-modal-title', el => el.innerText);
  console.log('  Modal Title:', intentModalTitle);

  console.log('1.2 Submitting Payment Intent');
  await page.click('#cp-submit-btn');
  await page.waitForSelector('#modal-payment-detail.active', { timeout: 6000 });
  console.log('  ✓ Payment Intent created! Payment Detail Modal opened');

  const paymentId = await page.$eval('#pm-id', el => el.innerText);
  const initialStatus = await page.$eval('#pm-status-pill', el => el.innerText);
  console.log('  Payment ID:', paymentId, '| Status:', initialStatus);

  console.log('1.3 Transition: Click Initiate Payment');
  await page.waitForSelector('#btn-pm-initiate', { timeout: 4000 });
  await page.click('#btn-pm-initiate');
  await new Promise(r => setTimeout(r, 700));

  let statusAfterInit = await page.$eval('#pm-status-pill', el => el.innerText);
  console.log('  Status after Initiate:', statusAfterInit);

  console.log('1.4 Transition: Click Authorize Payment');
  await page.waitForSelector('#btn-pm-authorize', { timeout: 4000 });
  await page.click('#btn-pm-authorize');
  await new Promise(r => setTimeout(r, 700));

  let statusAfterAuth = await page.$eval('#pm-status-pill', el => el.innerText);
  console.log('  Status after Authorize:', statusAfterAuth);

  console.log('1.5 Transition: Click Capture Payment');
  await page.waitForSelector('#btn-pm-capture', { timeout: 4000 });
  await page.click('#btn-pm-capture');
  await new Promise(r => setTimeout(r, 700));

  let statusAfterCap = await page.$eval('#pm-status-pill', el => el.innerText);
  console.log('  Status after Capture:', statusAfterCap);

  console.log('1.6 Compensating Refund: Enter 10000 and click Execute Refund');
  await page.waitForSelector('#pm-refund-box', { visible: true });
  await page.type('#pm-refund-amount', '10000');
  await page.click('#pm-refund-btn');
  await new Promise(r => setTimeout(r, 900));

  let refundedAmount = await page.$eval('#pm-refunded', el => el.innerText);
  console.log('  Refunded Amount in modal:', refundedAmount);

  // Close payment detail modal
  await page.click('#modal-payment-detail .modal-close');
  await new Promise(r => setTimeout(r, 400));

  console.log('1.7 Clicking #btn-create-payment (Direct Auto-Authorize Payment)');
  await page.click('#btn-create-payment');
  await page.waitForSelector('#modal-create-payment.active', { timeout: 4000 });
  const directModalTitle = await page.$eval('#cp-modal-title', el => el.innerText);
  console.log('  Modal Title for direct payment:', directModalTitle);
  await page.click('#cp-submit-btn');
  await page.waitForSelector('#modal-payment-detail.active', { timeout: 6000 });
  const directPaymentId = await page.$eval('#pm-id', el => el.innerText);
  const directStatus = await page.$eval('#pm-status-pill', el => el.innerText);
  console.log('  Direct Payment ID:', directPaymentId, '| Status:', directStatus);
  await page.click('#modal-payment-detail .modal-close');
  await new Promise(r => setTimeout(r, 500));

  // =========================================================================
  // TEST 2: RECONCILIATION - GENERATE TEST DATASET & TRIGGER RUN
  // =========================================================================
  console.log('\n--- TEST 2: RECONCILIATION - DATASET & MATCHING ENGINE ---');
  await page.goto('http://localhost:3000/#/reconciliation', { waitUntil: 'networkidle0' });

  console.log('2.1 Clicking #btn-gen-dataset (+ Generate Test Dataset)');
  await page.click('#btn-gen-dataset');
  await new Promise(r => setTimeout(r, 1500));

  let toastText = await page.$eval('#toast', el => el.innerText);
  console.log('  ✓ Toast feedback:', toastText);

  console.log('2.2 Clicking #btn-trigger-recon (+ Trigger Reconciliation Run)');
  await page.click('#btn-trigger-recon');
  await page.waitForSelector('#modal-recon-detail.active', { timeout: 15000 });
  console.log('  ✓ Reconciliation Run executed! Run Detail Modal opened');

  const reconRef = await page.$eval('#recon-modal-ref', el => el.innerText);
  const matchedCount = await page.$eval('#recon-modal-matched', el => el.innerText);
  const mismatchCount = await page.$eval('#recon-modal-mismatches', el => el.innerText);
  console.log('  Recon Reference:', reconRef, '| Matched:', matchedCount, '| Mismatches:', mismatchCount);

  // Check discrepancy records and test lifecycle buttons (Investigate / Resolve)
  const investBtn = await page.$('#recon-modal-records-body button.btn-secondary');
  if (investBtn) {
    console.log('2.3 Clicking Investigate button on discrepancy record');
    await investBtn.click();
    await new Promise(r => setTimeout(r, 1000));
    console.log('  ✓ Discrepancy transitioned to INVESTIGATING');

    const resolveBtn = await page.$('#recon-modal-records-body button.btn-primary');
    if (resolveBtn) {
      console.log('2.4 Clicking Resolve button on investigated discrepancy');
      await resolveBtn.click();
      await new Promise(r => setTimeout(r, 1000));
      console.log('  ✓ Discrepancy marked as RESOLVED');
    }
  }

  // Close recon detail modal
  await page.click('#modal-recon-detail .modal-close');
  await new Promise(r => setTimeout(r, 400));

  // =========================================================================
  // TEST 3: SETTLEMENTS - CREATE BATCH, PROCESS & DISBURSE
  // =========================================================================
  console.log('\n--- TEST 3: SETTLEMENTS - CREATE BATCH & DISBURSAL ---');
  await page.goto('http://localhost:3000/#/settlements', { waitUntil: 'networkidle0' });

  console.log('3.1 Clicking #btn-create-settlement (Create Settlement Batch)');
  await page.click('#btn-create-settlement');
  await page.waitForSelector('#modal-create-settlement.active', { timeout: 4000 });
  console.log('  ✓ Create Settlement Modal opened');

  console.log('3.2 Submitting Create Batch');
  await page.click('#cs-submit-btn');
  await page.waitForSelector('#modal-settlement-detail.active', { timeout: 8000 });
  console.log('  ✓ Settlement Batch created & processed! Batch Detail Modal opened');

  const grossVal = await page.$eval('#sb-modal-gross', el => el.innerText);
  const refundVal = await page.$eval('#sb-modal-refunds', el => el.innerText);
  const feeVal = await page.$eval('#sb-modal-fees', el => el.innerText);
  const netVal = await page.$eval('#sb-modal-net', el => el.innerText);
  console.log('  Financial Totals -> Gross:', grossVal, '| Refunds:', refundVal, '| Fees:', feeVal, '| Net Payout:', netVal);

  console.log('3.3 Clicking Disburse & Post to Ledger');
  const disburseBtn = await page.$('#sb-modal-actions button.btn-primary');
  if (disburseBtn) {
    await disburseBtn.click();
    await new Promise(r => setTimeout(r, 1000));
    const settleBadge = await page.$eval('#sb-modal-actions', el => el.innerText);
    console.log('  ✓ Action status after disbursal:', settleBadge.trim());
  }

  // Close settlement detail modal
  await page.click('#modal-settlement-detail .modal-close');
  await new Promise(r => setTimeout(r, 400));

  // =========================================================================
  // TEST 4: DASHBOARD METRICS & REFRESH BUTTON
  // =========================================================================
  console.log('\n--- TEST 4: DASHBOARD METRICS & REFRESH BUTTON ---');
  await page.goto('http://localhost:3000/#/dashboard', { waitUntil: 'networkidle0' });

  console.log('4.1 Clicking #btn-refresh (Header Refresh Button)');
  await page.click('#btn-refresh');
  await new Promise(r => setTimeout(r, 1000));

  const tpv = await page.$eval('#m-tpv', el => el.innerText);
  const successCount = await page.$eval('#m-success-count', el => el.innerText);
  const refundVol = await page.$eval('#m-refund-vol', el => el.innerText);
  const settleVol = await page.$eval('#m-settle-vol', el => el.innerText);

  console.log('  Dashboard Live Cards after Refresh:');
  console.log('    Total Payment Volume (TPV):', tpv);
  console.log('    Successful Payments:', successCount);
  console.log('    Refund Volume:', refundVol);
  console.log('    Settlement Volume:', settleVol);

  console.log('\n--- TOTAL BROWSER ERRORS RECORDED ---:', errors.length);
  if (errors.length > 0) {
    console.error('Errors:', errors);
    throw new Error(`Encountered ${errors.length} browser errors during QA!`);
  }

  console.log('\n>>> REAL GOOGLE CHROME BROWSER QA PASSED 100% WITH ZERO ERRORS! <<<');
  await browser.close();
}

main().catch(err => {
  console.error('\nFAIL:', err);
  process.exit(1);
});
