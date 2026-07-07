import { describe, expect, test } from 'bun:test';

import {
  encodeClientConnectionPayload,
  parseClientConnectionPayload,
  buildPairingConnectionPayload,
  encodePairingConnectionPayload,
  parsePairingConnectionPayload,
} from './connectionPayload';

describe('connection payload helpers', () => {
  test('preserves legacy v1 connect payload parsing', () => {
    const encoded = encodeClientConnectionPayload({
      v: 1,
      serverUrl: 'https://runtime.example',
      token: 'oc_client_token',
      label: 'Runtime',
    });

    expect(parseClientConnectionPayload(encoded)).toEqual({
      v: 1,
      serverUrl: 'https://runtime.example',
      token: 'oc_client_token',
      label: 'Runtime',
    });
  });

  test('round-trips v2 pairing payloads', () => {
    const payload = buildPairingConnectionPayload({
      pairingId: 'pair_123',
      secret: 'one-time-secret',
      label: 'Desktop',
      fingerprint: 'ABCD-1234',
      expiresAt: '2099-01-01T00:00:00.000Z',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096/', priority: 20 },
        { type: 'tunnel', url: 'https://runtime.example/', priority: 10 },
      ],
    });

    const encoded = encodePairingConnectionPayload(payload);

    expect(encoded.startsWith('openchamber://connect?v=2&p=')).toBe(true);
    expect(parsePairingConnectionPayload(encoded)).toEqual({
      ...payload,
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096', priority: 20 },
        { type: 'tunnel', url: 'https://runtime.example', priority: 10 },
      ],
    });
  });

  test('rejects invalid v2 pairing payloads', () => {
    expect(parsePairingConnectionPayload('openchamber://connect?v=1&server=https://runtime.example&token=t')).toBeNull();
    expect(parsePairingConnectionPayload('openchamber://connect?v=2&p=not-json')).toBeNull();

    const missingSecret = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      candidates: [{ type: 'lan', url: 'http://runtime.example' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${missingSecret}`)).toBeNull();

    const invalidCandidate = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      secret: 'secret',
      candidates: [{ type: 'lan', url: 'file:///tmp/socket' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${invalidCandidate}`)).toBeNull();

    const expired = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      secret: 'secret',
      expiresAt: '2000-01-01T00:00:00.000Z',
      candidates: [{ type: 'lan', url: 'http://runtime.example' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${expired}`)).toBeNull();
  });
});
