// ── Web fetch（CC 官方 /alpha/web-fetch 服务端工具）─────────────────────
// 官方 CLI 1.93.2 内置的 web_fetch 服务端抓取工具，打的是 /alpha/web-fetch。
// 支持 SSRF 防护（拦截私网与云元数据、DNS重绑定防护、禁止重定向到私网）、
// 15分钟结果 LRU 缓存与历史回放去重、流式响应体上限防护。
import net from 'node:net';
import dns from 'node:dns/promises';
import { isPrivateAddress } from './alerts.mjs';

export const WEB_FETCH_ROUTE = '/alpha/web-fetch';
export const DEFAULT_WEB_FETCH_MAX_USES = 5;
export const MAX_FETCH_URL_LENGTH = 2000;
export const FETCH_CHUNK_SIZE = 100000; // 单次读取最大字符数（100KB），可通过 startIndex 续读
export const DEFAULT_FETCH_TTL_MS = 15 * 60 * 1000; // 15 分钟
export const DEFAULT_MAX_CACHE_ENTRIES = 100;
export const DEFAULT_MAX_ENTRY_BYTES = 500 * 1024; // 500KB
export const MAX_FETCH_BODY_BYTES = 2 * 1024 * 1024; // 响应体读取硬上限 2MB，防止恶意 OOM
export const MIN_FETCH_TIMEOUT_SECONDS = 1;
export const MAX_FETCH_TIMEOUT_SECONDS = 60; // timeout 上限 60s
export const DEFAULT_FETCH_TIMEOUT_SECONDS = 15;
export const MAX_REDIRECT_DEPTH = 3; // 手工跟随重定向跳数上限

/**
 * 无论从请求参数、环境变量 CC_WEB_FETCH_TIMEOUT_MS 还是默认值，
 * 最终生效的超时时间一处钳制在 [1s, 60s] 区间内。
 */
export function clampFetchTimeoutSeconds(val) {
  const n = typeof val === 'number' ? val : Number(val);
  const candidate = (Number.isFinite(n) && n > 0)
    ? n
    : (() => {
        const envVal = Number(process.env.CC_WEB_FETCH_TIMEOUT_MS);
        return (Number.isFinite(envVal) && envVal > 0) ? (envVal / 1000) : DEFAULT_FETCH_TIMEOUT_SECONDS;
      })();
  return Math.min(Math.max(candidate, MIN_FETCH_TIMEOUT_SECONDS), MAX_FETCH_TIMEOUT_SECONDS);
}

export const WEB_FETCH_TIMEOUT_MS = 15000;

export const WEB_FETCH_SCHEMA = {
  name: 'web_fetch',
  description: 'Fetches the contents of a specific URL and returns it as clean markdown, plain text, or raw HTML.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch. Must begin with http:// or https://' },
      format: { type: 'string', enum: ['markdown', 'text', 'html'], description: 'Output format (default markdown)' },
      startIndex: { type: 'number', description: 'Character offset to start reading from' },
      timeout: { type: 'number', description: 'Optional timeout in seconds (max 60s)' },
    },
    required: ['url'],
  },
};

const BLOCKED_HOST_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback', 'broadcasthost']);

export function isBlockedIp(ip) {
  const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!s) return true;
  // 显式拒绝 0.0.0.0、::、::1 这类
  if (s === '0.0.0.0' || s === '::' || s === '::1' || s === '0:0:0:0:0:0:0:0') return true;
  // 显式拒绝 ::ffff:127.0.0.1、::ffff:0.0.0.0 等映射地址
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7);
    if (v4 === '0.0.0.0' || v4.startsWith('127.') || v4.startsWith('169.254.') || isPrivateAddress(v4)) {
      return true;
    }
  }
  return isPrivateAddress(s);
}

function isPrivateOrLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || BLOCKED_HOST_NAMES.has(h)) return true;
  return isPrivateAddress(h);
}

/**
 * 域名 DNS 预解析与二次解析比对校验（防御 DNS Rebinding 攻击）
 *
 * 【架构限制说明（方案 B）】：
 * 云端 CommandCode 官方 /alpha/web-fetch 服务端抓取接口协议仅支持传递 { url, format }，
 * 请求抓取由 CC 云端集群发起并在云端远端独立进行 DNS 解析。云端接口不支持传入固化的 IP 地址，
 * 亦不支持自定义 Host 请求头（在客户端将 URL 中的域名替换为 IP 会导致 HTTPS SNI 握手域名不匹配被拒）。
 *
 * 因此，客户端本地的 DNS 解析及二次比对只能作为「本地环境尽力防御与减少误报」的防护层，
 * 本地无法强制约束云端执行抓取时的实际连接 IP，仍存在 TOCTOU 理论窗口。
 *
 * 【补偿防护措施】：
 * 1. 严格限制仅允许标准 HTTP/HTTPS 端口（80/443，以及默认端口），在 guardFetchUrl 中硬编码拒绝所有非标端口（如 22, 6379, 3306, 8080 等内网敏感服务端口）；
 * 2. 严格限制返回格式仅为 markdown/text/html 文本，流式读取执行 2MB 累计字节硬上限，超限立即释放连接防内存耗尽；
 * 3. 本地保留二次 DNS 解析与一致性比对，过滤掉常见 TTL 极短且本地可捕获的重绑定域名；
 * 4. 辅助请求代理严格复用主请求首轮 route，缺 route 抛错阻断，防出口泄露。
 */
export async function resolveAndValidateHost(hostname, opts = {}) {
  const lookup = opts.lookupImpl || (async (h) => {
    return dns.lookup(h, { all: true });
  });

  const cleanHost = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!cleanHost || BLOCKED_HOST_NAMES.has(cleanHost)) {
    return { ok: false, error: `Host "${cleanHost}" is blocked.` };
  }

  if (net.isIP(cleanHost)) {
    if (isBlockedIp(cleanHost)) {
      return { ok: false, error: `IP "${cleanHost}" is private, loopback, or reserved and cannot be fetched.` };
    }
    return { ok: true, ips: [cleanHost] };
  }

  // 第一次 DNS 解析
  let addrs1;
  try {
    const res = await lookup(cleanHost, { all: true });
    addrs1 = Array.isArray(res) ? res.map(r => typeof r === 'string' ? r : r.address) : [res?.address || String(res)];
  } catch (err) {
    return { ok: false, error: `DNS lookup failed for "${cleanHost}": ${err.message}` };
  }

  if (!addrs1 || addrs1.length === 0) {
    return { ok: false, error: `No IP addresses found for host "${cleanHost}".` };
  }

  for (const ip of addrs1) {
    if (isBlockedIp(ip)) {
      return { ok: false, error: `Host "${cleanHost}" resolved to blocked IP "${ip}".` };
    }
  }

  // 第二次 DNS 解析比对：防范 TTL 极短或重绑定攻击（第一次公网通过，第二次指向 127.0.0.1 或其它 IP）
  let addrs2;
  try {
    const res2 = await lookup(cleanHost, { all: true });
    addrs2 = Array.isArray(res2) ? res2.map(r => typeof r === 'string' ? r : r.address) : [res2?.address || String(res2)];
  } catch (err) {
    return { ok: false, error: `Second DNS lookup failed for "${cleanHost}": ${err.message}` };
  }

  for (const ip of addrs2) {
    if (isBlockedIp(ip)) {
      return { ok: false, error: `DNS rebinding detected: host "${cleanHost}" resolved to blocked IP "${ip}" on second lookup.` };
    }
  }

  const set1 = new Set(addrs1);
  const isConsistent = addrs2.length === addrs1.length && addrs2.every(ip => set1.has(ip));
  if (!isConsistent) {
    return { ok: false, error: `DNS rebinding detected: host "${cleanHost}" resolved to different IP addresses.` };
  }

  return { ok: true, ips: addrs1 };
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
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return { ok: false, error: `Port "${parsed.port}" is not allowed. Only standard ports (80, 443) are permitted.` };
  }
  if (!parsed.hostname.includes('.') && !parsed.hostname.includes(':')) {
    return { ok: false, error: `"${parsed.hostname}" is not a public hostname. Use a fully qualified domain like https://example.com.` };
  }
  const upgraded = parsed.protocol === 'http:';
  if (upgraded) {
    parsed.protocol = 'https:';
  }
  return { ok: true, url: parsed.toString(), upgraded, parsed };
}

/**
 * 流式读取响应体并施加累计字节硬上限，防止大响应耗尽内存
 */
export async function readLimitedResponseBody(resp, maxBytes = MAX_FETCH_BODY_BYTES) {
  const cl = resp.headers?.get ? resp.headers.get('content-length') : resp.headers?.['content-length'];
  if (cl) {
    const len = parseInt(cl, 10);
    if (Number.isFinite(len) && len > maxBytes) {
      throw new Error(`Response body exceeds size limit (${len} bytes; max ${maxBytes} bytes).`);
    }
  }

  if (!resp.body) return '';

  if (typeof resp.body.getReader === 'function') {
    const reader = resp.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const byteLen = value.byteLength || value.length || 0;
          totalBytes += byteLen;
          if (totalBytes > maxBytes) {
            try { await reader.cancel(); } catch {}
            throw new Error(`Response body exceeded limit of ${maxBytes} bytes.`);
          }
          chunks.push(value);
        }
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    const buf = Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c)));
    return buf.toString('utf8');
  }

  if (typeof resp.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of resp.body) {
      const byteLen = chunk.byteLength || chunk.length || 0;
      totalBytes += byteLen;
      if (totalBytes > maxBytes) {
        if (typeof resp.body.destroy === 'function') resp.body.destroy();
        throw new Error(`Response body exceeded limit of ${maxBytes} bytes.`);
      }
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c)));
    return buf.toString('utf8');
  }

  const text = await resp.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`Response body exceeded limit of ${maxBytes} bytes.`);
  }
  return text;
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
      map.delete(key);
      map.set(key, entry);
      return entry;
    },
    set(key, val) {
      if (!val || typeof val.content !== 'string') return;
      const bytes = Buffer.byteLength(val.content, 'utf8');
      if (bytes > maxEntryBytes) return;

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
    safeFormat = urlOrParams.format || (typeof format === 'string' && ['markdown', 'text', 'html'].includes(format) ? format : 'markdown');
    safeApiKey = typeof apiKey === 'string' ? apiKey : (typeof format === 'string' && !['markdown', 'text', 'html'].includes(format) ? format : '');
    safeRoute = (apiKey && typeof apiKey === 'object' && !('aborted' in apiKey)) ? apiKey : (route || null);
    safeSignal = (signal && typeof signal === 'object' && 'aborted' in signal)
      ? signal
      : (route && typeof route === 'object' && 'aborted' in route) ? route : null;
    safeOpts = {
      ...urlOrParams,
      ...(typeof signal === 'object' && signal !== null && !('aborted' in signal) ? signal : {}),
      ...(typeof opts === 'object' && opts !== null ? opts : {}),
    };
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

  // 1. URL 基础格式与字面量 IP SSRF 校验
  const guarded = guardFetchUrl(url);
  if (!guarded.ok) {
    return { ok: false, error: guarded.error, errorCode: 'invalid_input' };
  }

  // 2. DNS 解析与防重绑定校验
  const hostname = new URL(guarded.url).hostname;
  const dnsRes = await resolveAndValidateHost(hostname, { lookupImpl: safeOpts.lookupImpl });
  if (!dnsRes.ok) {
    return { ok: false, error: dnsRes.error, errorCode: 'invalid_input' };
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

  // 3. 超时时间保护：无论来自参数、环境变量还是默认值，均统一钳制在 [1s, 60s]
  const timeoutSec = clampFetchTimeoutSeconds(safeOpts.timeout);
  const timeoutMs = timeoutSec * 1000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = safeSignal ? AbortSignal.any([safeSignal, timeoutSignal]) : timeoutSignal;

  // 4. 辅助请求代理出口：严格复用主请求绑定的 route，拿不到则抛错阻断，不许回退到全局代理或直连
  let proxyAddress = undefined;
  if (safeRoute && typeof safeRoute === 'object') {
    if (safeRoute.available === false) {
      const err = new Error(safeRoute.reason || 'Bound proxy route is unavailable');
      err.code = 'PROXY_ROUTE_UNAVAILABLE';
      throw err;
    }
    proxyAddress = safeRoute.address;
  } else if (typeof safeRoute === 'string') {
    proxyAddress = safeRoute;
  } else if (safeOpts.proxyAddress !== undefined) {
    proxyAddress = safeOpts.proxyAddress;
  } else if (safeOpts.route) {
    if (safeOpts.route.available === false) {
      const err = new Error(safeOpts.route.reason || 'Bound proxy route is unavailable');
      err.code = 'PROXY_ROUTE_UNAVAILABLE';
      throw err;
    }
    proxyAddress = safeOpts.route.address;
  } else if (safeOpts.allowDirect) {
    proxyAddress = null;
  }

  if (proxyAddress === undefined) {
    const err = new Error('Missing bound proxy route for web_fetch helper request');
    err.code = 'PROXY_ROUTE_UNAVAILABLE';
    throw err;
  }

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
  let targetUrl = `${apiBase}${WEB_FETCH_ROUTE}`;

  let resp;
  let currentFetchUrl = safeUrl;
  let redirectCount = 0;

  try {
    // 循环支持抓取，fetch 时显式设置 redirect: 'manual'
    while (true) {
      const fetchOptions = {
        method: 'POST',
        headers,
        signal: combined,
        redirect: 'manual', // 禁止底层自动跟随重定向，防止 302 击穿内网
        body: JSON.stringify({ url: currentFetchUrl, format: canonicalFormat }),
      };

      resp = typeof safeOpts.upstreamFetch === 'function'
        ? await safeOpts.upstreamFetch(targetUrl, fetchOptions, proxyAddress)
        : await fetcher(targetUrl, fetchOptions);

      // 处理 3xx 重定向
      if (resp && resp.status >= 300 && resp.status < 400) {
        redirectCount++;
        if (redirectCount > MAX_REDIRECT_DEPTH) {
          return { ok: false, error: `Too many redirects (max ${MAX_REDIRECT_DEPTH})`, errorCode: 'invalid_input' };
        }
        const location = resp.headers?.get ? resp.headers.get('location') : resp.headers?.['location'];
        if (!location) {
          return { ok: false, error: `HTTP ${resp.status} redirect missing Location header`, errorCode: 'unavailable' };
        }
        let nextUrl;
        try {
          nextUrl = new URL(location, currentFetchUrl).toString();
        } catch {
          return { ok: false, error: `Invalid redirect location "${location}"`, errorCode: 'invalid_input' };
        }

        // 每一跳重定向都重新做全量 SSRF 校验
        const checkGuarded = guardFetchUrl(nextUrl);
        if (!checkGuarded.ok) {
          return { ok: false, error: `Redirect to blocked URL: ${checkGuarded.error}`, errorCode: 'invalid_input' };
        }
        const nextHost = new URL(checkGuarded.url).hostname;
        const nextDns = await resolveAndValidateHost(nextHost, { lookupImpl: safeOpts.lookupImpl });
        if (!nextDns.ok) {
          return { ok: false, error: `Redirect target SSRF blocked: ${nextDns.error}`, errorCode: 'invalid_input' };
        }

        currentFetchUrl = checkGuarded.url;
        continue;
      }
      break;
    }
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

  // 5. 响应体流式读取与累计字节上限防护
  let rawBodyText;
  try {
    rawBodyText = await readLimitedResponseBody(resp, MAX_FETCH_BODY_BYTES);
  } catch (err) {
    return { ok: false, error: err.message, errorCode: 'unavailable' };
  }

  let data;
  try {
    data = JSON.parse(rawBodyText);
  } catch {
    data = { content: rawBodyText };
  }

  const rawContent = data.content ?? data.text ?? data.result ?? (typeof data === 'string' ? data : '');
  const finalUrl = data.url || currentFetchUrl;
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
