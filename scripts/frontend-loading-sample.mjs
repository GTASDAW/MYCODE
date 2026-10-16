import assert from 'node:assert/strict';

/** Each scheduled attempt returns a record, including context/CDP/init-script setup failures. */
export async function runLoadingSample({ browser, viewport, size, variant, round, sequence, url, settings }) {
  const sample = { sequence, viewport, variant, round, success: false, listVisibleMs: null, lcpMs: null, dclMs: null,
    encodedJsCssBytes: 0, resources: [], failedResources: [], apiResponses: [], failure: null };
  let context;
  let activityResponse;
  let phase = 'setup';
  try {
    context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, serviceWorkers: 'block' });
    const page = await context.newPage();
    const requests = new Map();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: settings.network.latencyMs,
      downloadThroughput: settings.network.downloadBitsPerSecond / 8, uploadThroughput: settings.network.uploadBitsPerSecond / 8 });
    cdp.on('Network.requestWillBeSent', event => {
      const pathname = new URL(event.request.url).pathname;
      if (pathname.endsWith('.js') || pathname.endsWith('.css')) requests.set(event.requestId,
        { path: pathname, status: null, mimeType: null, fromDiskCache: false, type: pathname.endsWith('.js') ? 'js' : 'css' });
    });
    cdp.on('Network.responseReceived', event => {
      const pathname = new URL(event.response.url).pathname;
      if (pathname.endsWith('.js') || pathname.endsWith('.css')) requests.set(event.requestId, { path: pathname,
        status: event.response.status, mimeType: event.response.mimeType,
        fromDiskCache: Boolean(event.response.fromDiskCache || event.response.fromServiceWorker || event.response.fromPrefetchCache),
        type: pathname.endsWith('.js') ? 'js' : 'css' });
    });
    cdp.on('Network.loadingFinished', event => {
      const resource = requests.get(event.requestId);
      if (resource) { sample.resources.push({ ...resource, encodedBytes: event.encodedDataLength }); sample.encodedJsCssBytes += event.encodedDataLength; }
    });
    cdp.on('Network.loadingFailed', event => {
      const resource = requests.get(event.requestId);
      if (resource) sample.failedResources.push({ path: resource.path, reason: event.canceled ? 'canceled' : 'network failure' });
    });
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.startsWith('/api/')) sample.apiResponses.push({ path: pathname, status: response.status() });
    });
    await page.addInitScript(() => {
      const state = { lcp: null, listVisible: null };
      Object.defineProperty(window, '__loadingMeasurement', { value: state });
      new PerformanceObserver(list => { for (const entry of list.getEntries()) state.lcp = entry.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      new MutationObserver(() => {
        const card = document.querySelector('.activity-card');
        if (state.listVisible === null && card && card.getBoundingClientRect().height > 0) state.listVisible = performance.now();
      }).observe(document, { subtree: true, childList: true });
    });
    phase = 'navigation';
    activityResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/activities/search', { timeout: settings.timeoutMs })
      .then(response => ({ response }), failure => ({ failure: failure.name }));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: settings.timeoutMs });
    const result = await activityResponse;
    assert(result.response, 'Activity response was not received');
    assert.equal(result.response.status(), 200, 'Real activity API must succeed');
    const payload = await result.response.json();
    assert(payload.items?.length > 0, 'Read-only demo data must contain at least one activity');
    await page.locator('.activity-card').first().waitFor({ state: 'visible', timeout: settings.timeoutMs });
    await page.waitForTimeout(1000);
    Object.assign(sample, await page.evaluate(() => ({ lcpMs: window.__loadingMeasurement.lcp,
      listVisibleMs: window.__loadingMeasurement.listVisible,
      dclMs: performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd ?? null })));
    assert(sample.listVisibleMs !== null && sample.lcpMs !== null && sample.dclMs > 0, 'Browser timing evidence is missing');
    assert(sample.resources.length > 0 && sample.resources.every(resource => resource.status === 200 && !resource.fromDiskCache), 'JS/CSS assets must be real cold HTTP responses');
    assert.equal(sample.failedResources.length, 0, 'A JS/CSS request failed');
    sample.success = true;
  } catch (failure) {
    sample.failure = failure.name === 'TimeoutError' ? 'timeout' : phase === 'setup' ? 'browser setup failed' : 'navigation/API/resource/timing validation failed';
  } finally {
    try { await context?.close(); }
    catch { sample.success = false; sample.failure = 'browser context cleanup failed'; }
    await activityResponse;
    if (sample.failedResources.length > 0) { sample.success = false; sample.failure ??= 'JS/CSS network request failed'; }
  }
  return sample;
}
