import type { ResearchConfig } from './config.js';

export function publicUrl(raw: string): string {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()])
    if (/key|token|email|mailto|secret|signature/i.test(key))
      url.searchParams.set(key, '[redacted]');
  return url.href;
}
export class ResearchHttpError extends Error {
  constructor(
    readonly status: number,
    hostname: string,
  ) {
    super(`HTTP ${status} from ${hostname}`);
  }
}
export class ResearchHttp {
  constructor(
    readonly config: ResearchConfig,
    readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}
  /** `headers` carries credentials that must stay out of the URL; they are never echoed. */
  async get(
    raw: string,
    maxBytes = this.config.maxDownloadBytes,
    signal?: AbortSignal,
    headers: Record<string, string> = {},
  ) {
    maxBytes = Math.min(maxBytes, this.config.maxDownloadBytes);
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Research retrieval requires an HTTP(S) URL');
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const response = await this.fetcher(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        'user-agent': `Clawstrum-research/0.1${this.config.email ? ` (mailto:${this.config.email})` : ''}`,
        accept: '*/*',
        ...headers,
      },
      redirect: 'follow',
    }).catch(() => {
      signal?.throwIfAborted();
      throw new Error(`Request failed or timed out at ${url.hostname}`);
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ResearchHttpError(response.status, url.hostname);
    }
    const size = Number(response.headers.get('content-length'));
    if (size > maxBytes) {
      await response.body?.cancel();
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty response body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
        chunks.push(part.value);
      }
    } catch {
      await reader.cancel().catch(() => {});
      signal?.throwIfAborted();
      throw new Error(`Response interrupted or exceeded ${maxBytes} bytes at ${url.hostname}`);
    } finally {
      reader.releaseLock();
    }
    return {
      bytes: Buffer.concat(chunks),
      url: response.url || url.href,
      type: response.headers.get('content-type') ?? '',
      headers: response.headers,
    };
  }
  async json(url: string, signal?: AbortSignal): Promise<any> {
    const response = await this.get(url, Math.min(this.config.maxDownloadBytes, 5000000), signal);
    try {
      return JSON.parse(response.bytes.toString('utf8'));
    } catch {
      throw new Error(`Invalid JSON response from ${new URL(url).hostname}`);
    }
  }
}
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const n = code[0]!.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\uFFFD';
    })
    .replace(
      /&(?:nbsp|amp|lt|gt|quot|apos);/g,
      (entity) =>
        ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[
          entity
        ]!,
    );
}
export function markupText(text: string): string {
  return decodeEntities(
    text
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(?:p|div|sec|section|title|h[1-6]|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}
