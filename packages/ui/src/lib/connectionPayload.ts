const MAX_PAIRING_PAYLOAD_LENGTH = 16_384;

export type ClientConnectionPayload = {
  v: 1;
  serverUrl: string;
  token: string;
  label?: string;
};

export type PairingEndpointCandidate = {
  type: 'lan' | 'tunnel' | 'relay';
  url: string;
  priority?: number;
};

export type PairingConnectionPayload = {
  v: 2;
  pairingId: string;
  secret: string;
  label?: string;
  fingerprint?: string;
  expiresAt?: string;
  candidates: PairingEndpointCandidate[];
};

const globalWithBuffer = globalThis as typeof globalThis & {
  Buffer?: {
    from: (value: string, encoding?: string) => { toString: (encoding: string) => string };
  };
};

const base64UrlEncode = (value: string): string => {
  if (globalWithBuffer.Buffer) {
    return globalWithBuffer.Buffer.from(value, 'utf8').toString('base64url');
  }
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlDecode = (value: string): string | null => {
  try {
    if (globalWithBuffer.Buffer) {
      return globalWithBuffer.Buffer.from(value, 'base64url').toString('utf8');
    }
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};

const normalizeHttpUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/g, '');
  } catch {
    return null;
  }
};

const normalizePairingCandidate = (value: unknown): PairingEndpointCandidate | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type !== 'lan' && type !== 'tunnel' && type !== 'relay') return null;
  const url = normalizeHttpUrl(record.url);
  if (!url) return null;
  const priority = typeof record.priority === 'number' && Number.isFinite(record.priority)
    ? record.priority
    : undefined;
  return priority === undefined ? { type, url } : { type, url, priority };
};

const normalizePairingPayload = (value: unknown): PairingConnectionPayload | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 2) return null;
  const pairingId = typeof record.pairingId === 'string' ? record.pairingId.trim() : '';
  const secret = typeof record.secret === 'string' ? record.secret.trim() : '';
  if (!pairingId || !secret) return null;
  const candidates = Array.isArray(record.candidates)
    ? record.candidates.map(normalizePairingCandidate).filter((candidate): candidate is PairingEndpointCandidate => Boolean(candidate))
    : [];
  if (candidates.length === 0) return null;
  const expiresAt = typeof record.expiresAt === 'string' && record.expiresAt.trim() ? record.expiresAt.trim() : undefined;
  if (expiresAt) {
    const expiresTime = Date.parse(expiresAt);
    if (!Number.isFinite(expiresTime) || expiresTime <= Date.now()) return null;
  }
  const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim() : undefined;
  const fingerprint = typeof record.fingerprint === 'string' && record.fingerprint.trim() ? record.fingerprint.trim() : undefined;
  return {
    v: 2,
    pairingId,
    secret,
    ...(label ? { label } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    candidates,
  };
};

export const buildClientConnectionPayload = (input: {
  serverUrl: string;
  token: string;
  label?: string | null;
}): ClientConnectionPayload => ({
  v: 1,
  serverUrl: input.serverUrl.trim().replace(/\/+$/, ''),
  token: input.token.trim(),
  ...(input.label?.trim() ? { label: input.label.trim() } : {}),
});

export const encodeClientConnectionPayload = (payload: ClientConnectionPayload): string => {
  const params = new URLSearchParams();
  params.set('v', String(payload.v));
  params.set('server', payload.serverUrl);
  params.set('token', payload.token);
  if (payload.label) params.set('label', payload.label);
  return `openchamber://connect?${params.toString()}`;
};

export const parseClientConnectionPayload = (value: string): ClientConnectionPayload | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'openchamber:' || url.hostname !== 'connect') {
      return null;
    }
    const version = url.searchParams.get('v');
    const serverUrl = url.searchParams.get('server')?.trim() || '';
    const token = url.searchParams.get('token')?.trim() || '';
    const label = url.searchParams.get('label')?.trim() || '';

    if (version !== '1' || !serverUrl || !token) {
      return null;
    }

    try {
      const parsedServer = new URL(serverUrl);
      if (parsedServer.protocol !== 'http:' && parsedServer.protocol !== 'https:') {
        return null;
      }
    } catch {
      return null;
    }

    return buildClientConnectionPayload({ serverUrl, token, label });
  } catch {
    return null;
  }
};

export const buildPairingConnectionPayload = (input: Omit<PairingConnectionPayload, 'v'>): PairingConnectionPayload => ({
  v: 2,
  pairingId: input.pairingId.trim(),
  secret: input.secret.trim(),
  ...(input.label?.trim() ? { label: input.label.trim() } : {}),
  ...(input.fingerprint?.trim() ? { fingerprint: input.fingerprint.trim() } : {}),
  ...(input.expiresAt?.trim() ? { expiresAt: input.expiresAt.trim() } : {}),
  candidates: input.candidates,
});

export const encodePairingConnectionPayload = (payload: PairingConnectionPayload): string => {
  const normalized = normalizePairingPayload(payload);
  if (!normalized) throw new Error('Invalid pairing connection payload');
  const params = new URLSearchParams();
  params.set('v', '2');
  params.set('p', base64UrlEncode(JSON.stringify(normalized)));
  return `openchamber://connect?${params.toString()}`;
};

export const parsePairingConnectionPayload = (value: string): PairingConnectionPayload | null => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'openchamber:' || url.hostname !== 'connect') return null;
    if (url.searchParams.get('v') !== '2') return null;
    const encoded = url.searchParams.get('p') || '';
    if (!encoded || encoded.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
    const decoded = base64UrlDecode(encoded);
    if (!decoded || decoded.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
    return normalizePairingPayload(JSON.parse(decoded) as unknown);
  } catch {
    return null;
  }
};
