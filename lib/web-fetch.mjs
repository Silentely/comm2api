// ── Web fetch（CC 官方 /alpha/web-fetch 服务端工具）─────────────────────
// 官方 CLI 1.93.2 内置的 web_fetch 服务端抓取工具，打的是 /alpha/web-fetch。
// 支持 SSRF 防护（拦截私网与云元数据）、15分钟结果 LRU 缓存与历史回放去重。
import { isPrivateAddress } from './alerts.mjs';

export const WEB_FETCH_ROUTE = '/alpha/web-fetch';
export const DEFAULT_WEB_FETCH_MAX_USES = 5;
export const MAX_FETCH_URL_LENGTH = 2000;
export const FETCH_CHUNK_SIZE = 100000; // 单次读取最大字符数（100KB），可通过 startIndex 续读
export const DEFAULT_FETCH_TTL_MS = 15 * 60 * 1000; // 15 分钟
export const DEFAULT_MAX_CACHE_ENTRIES = 100;
export const DEFAULT_MAX_ENTRY_BYTES = 500 * 1024; // 500KB

export const WEB_FETCH_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_WEB_FETCH_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 15000;
})();

export const WEB_FETCH_SCHEMA = {
  name: 'web_fetch',
  description: 'Fetches the contents of a specific URL and returns it as clean markdown, plain text, or raw HTML.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch. Must begin with http:// or https://' },
      format: { type: 'string', enum: ['markdown', 'text', 'html'], description: 'Output format (default markdown)' },
      startIndex: { type: 'number', description: 'Character offset to start reading from' },
      timeout: { type: 'number', description: 'Optional timeout in seconds' },
    },
    required: ['url'],
  },
};

const BLOCKED_HOST_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback', 'broadcasthost']);

function isPrivateOrLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || BLOCKED_HOST_NAMES.has(h)) return true;
  return isPrivateAddress(h);
}

/**
 * SSRF URL 防护与协议规范化
 * - 仅允许 http: 与 https: 协议
 * - 自动将 http: 升级为 https:
 * - 拒绝内嵌鉴权凭据 (user:pass@host)
 * - 拒绝非公开单段域名与私网/回环/云元数据地址 (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, ::1, fc00::/7, 169.254.169.254 等)
 */
export function guardFetchUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: 'URL must be a non-empty string.' };
  }
  const urlStr = rawUrl.trim();
  if (urlStr.length > MAX_FETCH_URL_LENGTH) {
    return { ok: false, error: `URL is too long (${urlStr.length} chars; max ${MAX_FETCH_URL_LENGTH}).` };
  }
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, error: `"${urlStr}" is not a valid URL. Provide a fully formed URL like https://example.com/page.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Unsupported protocol "${parsed.protocol}" — only http:// and https:// URLs can be fetched.` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URLs with embedded credentials (user:pass@host) are not allowed.' };
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    return { ok: false, error: `"${parsed.hostname}" resolves to a private, loopback, or link-local address and cannot be fetched.` };
  }
  if (!parsed.hostname.includes('.') && !parsed.hostname.includes(':')) {
    return { ok: false, error: `"${parsed.hostname}" is not a public hostname. Use a fully qualified domain like https://example.com.` };
  }
  const upgraded = parsed.protocol === 'http:';
  if (upgraded) {
    parsed.protocol = 'https:';
  }
  return { ok: true, url: parsed.toString(), upgraded };
}

/**
 * 内存 LRU 缓存工厂：按 ${format}:${url} 缓存抓取结果
 * - 默认 TTL: 15 分钟
 * - 默认容量: 100 项
 * - 单项体积上限: 500KB
 */
export function createFetchCache(opts = {}) {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_FETCH_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;

  const map = new Map();

  function evictOldest() {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }

  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (now() - entry.storedAt > ttlMs) {
        map.delete(key);
        return undefined;
      }
      // 刷新访问顺序 (LRU)
      map.delete(key);
      map.set(key, entry);
      return entry;
    },
    set(key, val) {
      if (!val || typeof val.content !== 'string') return;
      const bytes = Buffer.byteLength(val.content, 'utf8');
      if (bytes > maxEntryBytes) return; // 超出单项体积上限不入缓存

      map.delete(key);
      map.set(key, { ...val, storedAt: now() });
      while (map.size > maxEntries) {
        evictOldest();
      }
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}

export const defaultFetchCache = createFetchCache();
export function clearWebFetchCache() {
  defaultFetchCache.clear();
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * 对抓取正文进行格式化、重定向信息注入与 startIndex 分片处理
 */
export function formatFetchOutput({ requestedUrl, finalUrl, status = 200, content = '', startIndex = 0 }) {
  const total = content.length;
  const offset = Math.max(0, Number.isInteger(startIndex) ? startIndex : 0);
  if (offset > 0 && offset >= total) {
    return { ok: false, error: `startIndex ${offset} is past the end of the content (${total} characters total).` };
  }
  const end = Math.min(offset + FETCH_CHUNK_SIZE, total);
  const headerLines = [`URL: ${finalUrl || requestedUrl}`, `Status: ${status}`];
  if (finalUrl && requestedUrl && hostOf(finalUrl) !== hostOf(requestedUrl)) {
    headerLines.push(`Redirected: ${requestedUrl} → ${finalUrl}`);
  }
  const parts = [headerLines.join('\n'), '', content.slice(offset, end)];
  if (offset > 0 || end < total) {
    const hint = end < total ? ` Call web_fetch again with startIndex=${end} to continue reading.` : ' End of content.';
    parts.push('', `[Showing characters ${offset}-${end} of ${total}.${hint}]`);
  }
  return { ok: true, text: parts.join('\n') };
}

/**
 * 历史回放：将客户端原样带回的 web_fetch_tool_result 块还原为模型可读文本
 */
export function decodeWebFetchResultBlocks(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (typeof content === 'object') {
    if (content.error_code) {
      return `Fetch failed: ${content.error_code}`;
    }
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  if (Array.isArray(content)) {
    return content.map(c => typeof c === 'string' ? c : (c.text || c.content || JSON.stringify(c))).join('\n');
  }
  return String(content);
}

/**
 * 执行 web_fetch
 */
export async function executeWebFetch(urlOrParams, format, apiKey, route, signal, opts = {}) {
  let url = '';
  let safeFormat = 'markdown';
  let safeApiKey = '';
  let safeRoute = null;
  let safeSignal = null;
  let safeOpts = {};

  if (typeof urlOrParams === 'object' && urlOrParams !== null) {
    url = urlOrParams.url;
    safeFormat = urlOrParams.format || 'markdown';
    safeApiKey = format || '';
    safeRoute = apiKey || null;
    safeSignal = (route && typeof route === 'object' && 'aborted' in route) ? route : null;
    safeOpts = { ...urlOrParams, ...(signal || {}) };
  } else {
    url = urlOrParams;
    safeFormat = (typeof format === 'string' && ['markdown', 'text', 'html'].includes(format))
      ? format
      : (opts?.format || 'markdown');
    safeApiKey = (typeof apiKey === 'string' ? apiKey : '') || (typeof format === 'string' && !['markdown', 'text', 'html'].includes(format) ? format : '');
    safeRoute = route || null;
    safeSignal = (signal && typeof signal === 'object' && 'aborted' in signal)
      ? signal
      : (route && typeof route === 'object' && 'aborted' in route) ? route : null;
    safeOpts = opts || {};
  }

  const guarded = guardFetchUrl(url);
  if (!guarded.ok) {
    return { ok: false, error: guarded.error, errorCode: 'invalid_input' };
  }

  const safeUrl = guarded.url;
  const canonicalFormat = ['markdown', 'text', 'html'].includes(safeFormat) ? safeFormat : 'markdown';
  const cacheKey = `${canonicalFormat}:${safeUrl}`;
  const cache = safeOpts.cache || defaultFetchCache;

  const cached = cache.get(cacheKey);
  if (cached) {
    return formatFetchOutput({
      requestedUrl: safeUrl,
      finalUrl: cached.url,
      status: cached.status,
      content: cached.content,
      startIndex: safeOpts.startIndex,
    });
  }

  const timeoutMs = (Number(safeOpts.timeout) > 0 ? safeOpts.timeout * 1000 : undefined) || WEB_FETCH_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = safeSignal ? AbortSignal.any([safeSignal, timeoutSignal]) : timeoutSignal;

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'cli',
    'x-command-code-version': safeOpts.version || '1.93.2',
    'x-cli-environment': 'production',
    'Authorization': `Bearer ${safeApiKey}`,
  };
  if (safeOpts.headers?.['x-cmd-zdr'] === '1' || safeOpts.zdr) headers['x-cmd-zdr'] = '1';
  if (safeOpts.headers?.['x-session-id']) headers['x-session-id'] = safeOpts.headers['x-session-id'];
  if (safeOpts.headers?.['x-project-slug']) headers['x-project-slug'] = safeOpts.headers['x-project-slug'];
  if (safeOpts.headers?.['traceparent']) headers['traceparent'] = safeOpts.headers['traceparent'];

  const fetcher = safeOpts.upstreamFetch || globalThis.fetch;
  const apiBase = safeOpts.apiBase || 'https://api.commandcode.ai';
  const targetUrl = `${apiBase}${WEB_FETCH_ROUTE}`;
  const proxyAddress = safeRoute?.address || (typeof safeRoute === 'string' ? safeRoute : null);

  let resp;
  try {
    const fetchOptions = {
      method: 'POST',
      headers,
      signal: combined,
      body: JSON.stringify({ url: safeUrl, format: canonicalFormat }),
    };
    resp = typeof safeOpts.upstreamFetch === 'function'
      ? await safeOpts.upstreamFetch(targetUrl, fetchOptions, proxyAddress)
      : await fetcher(targetUrl, fetchOptions);
  } catch (e) {
    if (safeSignal?.aborted) throw e;
    return { ok: false, error: e.message, errorCode: 'unavailable' };
  }

  if (!resp.ok) {
    return {
      ok: false,
      error: `Upstream error: HTTP ${resp.status}`,
      errorCode: resp.status === 429 ? 'too_many_requests' : 'unavailable',
    };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { ok: false, error: 'Invalid JSON response from upstream', errorCode: 'unavailable' };
  }

  const rawContent = data.content ?? data.text ?? data.result ?? (typeof data === 'string' ? data : '');
  const finalUrl = data.url || safeUrl;
  const status = data.status || resp.status || 200;

  if (status >= 200 && status < 400 && typeof rawContent === 'string' && rawContent.length > 0) {
    cache.set(cacheKey, { content: rawContent, url: finalUrl, status });
  }

  return formatFetchOutput({
    requestedUrl: safeUrl,
    finalUrl,
    status,
    content: rawContent,
    startIndex: safeOpts.startIndex,
  });
}
