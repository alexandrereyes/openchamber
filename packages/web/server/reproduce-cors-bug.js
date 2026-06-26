/**
 * Reproduction script for CORS bug:
 * The OPTIONS preflight handler does not include X-OpenCode-Directory-Encoding
 * in the Access-Control-Allow-Headers response, causing the browser to block
 * /api/fs/list requests that send this custom header.
 *
 * Issue: https://github.com/openchamber/openchamber/issues/1853
 *
 * To run: bun run packages/web/server/reproduce-cors-bug.js
 */

import http from 'http';
import express from 'express';

// Replicate the exact CORS middleware from packages/web/server/index.js (lines 1110-1125)
const packagedClientOrigins = new Set(['openchamber-ui://app']);

const app = express();
app.use((req, res, next) => {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (packagedClientOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-OpenCode-Directory');
    res.setHeader('Access-Control-Expose-Headers', 'x-next-cursor');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
  }
  next();
});

app.get('/api/fs/list', (_req, res) => {
  res.json({ ok: true, entries: [] });
});

const server = app.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  try {
    // Simulate a browser OPTIONS preflight that requests x-opencode-directory-encoding
    const preflightResponse = await fetch(`${url}/api/fs/list`, {
      method: 'OPTIONS',
      headers: {
        origin: 'openchamber-ui://app',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-opencode-directory, x-opencode-directory-encoding',
      },
    });

    const allowHeaders = preflightResponse.headers.get('access-control-allow-headers') || '';
    console.log('=== CORS Preflight Response ===');
    console.log(`Status: ${preflightResponse.status}`);
    console.log(`Access-Control-Allow-Origin: ${preflightResponse.headers.get('access-control-allow-origin')}`);
    console.log(`Access-Control-Allow-Headers: ${allowHeaders}`);
    console.log();

    const expectedHeader = 'X-OpenCode-Directory-Encoding';
    const lowerAllowHeaders = allowHeaders.toLowerCase();
    if (lowerAllowHeaders.includes(expectedHeader.toLowerCase())) {
      console.log(`✓ PASS: "${expectedHeader}" is present in Access-Control-Allow-Headers`);
      console.log('  The bug does NOT reproduce (header is already allowed).');
    } else {
      console.log(`✗ FAIL: "${expectedHeader}" is MISSING from Access-Control-Allow-Headers`);
      console.log('  The bug IS reproduced: the browser preflight will fail because');
      console.log('  the server does not advertise support for the x-opencode-directory-encoding header.');
      console.log();
      console.log('  Per CORS spec, every custom header in Access-Control-Request-Headers must');
      console.log('  be present in Access-Control-Allow-Headers for the preflight to pass.');
      console.log('  The client sends x-opencode-directory-encoding via runtime-fetch.ts line 137,');
      console.log('  but the server does not allow it in the preflight response.');
    }

    // Also show that the actual GET would succeed without CORS
    console.log();
    console.log('=== Actual GET request (simulating what the browser would attempt after preflight) ===');
    const getResponse = await fetch(`${url}/api/fs/list`, {
      method: 'GET',
      headers: {
        origin: 'openchamber-ui://app',
        'x-opencode-directory': encodeURIComponent('/Users/test/Desktop/project'),
        'x-opencode-directory-encoding': 'uri',
      },
    });
    console.log(`Status: ${getResponse.status}`);
    console.log(`Body: ${await getResponse.text()}`);
    console.log('(Without browser CORS enforcement, the GET request works fine.)');

  } catch (err) {
    console.error('Error during reproduction:', err);
  } finally {
    server.close();
    process.exit(0);
  }
});
