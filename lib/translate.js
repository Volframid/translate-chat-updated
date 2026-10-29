'use strict';
const https = require('https');
let cooldownUntil = 0;
let cooldownReason = '', networkFailures = 0;
// Shared by replacement providers: changing zones/settings cannot bypass a
// rate-limit pause or start several simultaneous recovery probes.
const rate = { hits: 0, streak: 0, generation: 0, limited: false, probe: null,
  probes: 0, recovered: 0, successes: 20, lastLimitAt: null, nextStartAt: 0 };
function requestPolicy() {
  const recovering = rate.limited || rate.successes < 20;
  return { concurrency: recovering ? 1 : 2,
    spacingMs: rate.limited || rate.successes < 5 ? 1000 : rate.successes < 10 ? 750 : rate.successes < 20 ? 500 : 200,
    nextStartAt: recovering ? rate.nextStartAt : 0 };
}
function availability() {
  const retryAfterMs = Math.max(0, cooldownUntil - Date.now());
  if (retryAfterMs) return { available: false, retryAfterMs, reason: cooldownReason };
  if (rate.probe) return { available: false, retryAfterMs: Math.max(0, rate.probe.deadline - Date.now()), reason: 'rate-limit-probe' };
  return { available: true, retryAfterMs: 0, reason: '' };
}
function pause(reason, delay) {
  const until = Date.now() + delay;
  if (until > cooldownUntil) { cooldownUntil = until; cooldownReason = reason; }
}
function limited(permit, retryAfter) {
  rate.hits++;
  // Two requests from the same pre-limit burst count as two responses but
  // only one backoff wave. A later failed probe escalates the next wave.
  if (permit.generation === rate.generation) {
    rate.streak = Math.min(5, rate.streak + 1); rate.generation++;
    rate.limited = true; rate.probe = null; rate.successes = 0; rate.lastLimitAt = Date.now();
  }
  const seconds = typeof retryAfter === 'string' && /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
  // Date.parse also accepts strings such as "-10" as calendar dates. Only an
  // HTTP-date beginning with a weekday may use the date interpretation.
  const date = typeof retryAfter === 'string' && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*(?:,|\s)/i.test(retryAfter.trim()) ? Date.parse(retryAfter) : NaN;
  const serverDelay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 0;
  pause('http-429', Math.max(Math.min(900000, 60000 * Math.pow(2, Math.max(0, rate.streak - 1))),
    Number.isFinite(serverDelay) ? serverDelay : 0));
}
function acquire(handle, timeoutMs) {
  if (!availability().available || Date.now() < requestPolicy().nextStartAt) return null;
  const permit = { generation: rate.generation, handle, probe: rate.limited };
  if (permit.probe) { rate.probe = { handle, deadline: Date.now() + timeoutMs }; rate.probes++; }
  if (rate.limited || rate.successes < 20) rate.nextStartAt = Date.now() + requestPolicy().spacingMs;
  return permit;
}
function mayRetry(permit) {
  return permit.generation === rate.generation && Date.now() >= cooldownUntil &&
    (!rate.probe || rate.probe.handle === permit.handle);
}
function release(permit, error) {
  if (permit.generation !== rate.generation) return;
  const ownsProbe = rate.probe && rate.probe.handle === permit.handle;
  if (ownsProbe) rate.probe = null;
  if (error) {
    if (ownsProbe && error.message !== 'closed') pause('recovery-failed', 5000);
    return;
  }
  // A response already in flight when another request imposed a pause is not
  // a successful recovery probe and must not reopen the limiter.
  if (Date.now() < cooldownUntil || rate.limited && !ownsProbe) return;
  if (ownsProbe) { rate.limited = false; rate.recovered++; rate.successes = 1; }
  else if (rate.successes < 20) rate.successes++;
  if (rate.successes >= 20 && rate.lastLimitAt !== null && Date.now() - rate.lastLimitAt >= 600000) rate.streak = 0;
}
const LANGUAGES = new Set('af sq ar az eu bn be bg ca zh-CN zh-TW hr cs da nl en eo et tl fi fr gl ka de el gu ht he hi hu is id ga it ja kn ko la lv lt mk ms mt no fa pl pt ro ru ru sr sk sl es sw sv ta te th tr uk ur vi cy yi'.split(' '));
function language(value, source = false) {
  if (typeof value !== 'string') return null;
  let id = value.trim().toLowerCase();
  if (source && ['auto', 'any'].includes(id)) return 'auto';
  if (id === 'iw') id = 'he';
  if (id === 'zh-cn') id = 'zh-CN';
  if (id === 'zh-tw') id = 'zh-TW';
  return LANGUAGES.has(id) ? id : null;
}
function extractTranslation(body) {
  const json = JSON.parse(body);
  const segments = Array.isArray(json) ? json[0] : json && json.sentences;
  if (!Array.isArray(segments) || !segments.length) throw new Error('invalid-response');
  const parts = [];
  for (const part of segments) {
    const value = Array.isArray(part) ? part[0] : part && part.trans;
    // Google may include metadata-only sentence objects. Reject a segment
    // containing original text without its translation instead of losing it.
    if (value === undefined && part && !Array.isArray(part) && typeof part === 'object' && !('orig' in part)) continue;
    if (typeof value !== 'string') throw new Error('invalid-response');
    const original = Array.isArray(part) ? part[1] : part.orig;
    if (!value.trim() && typeof original === 'string' && original.trim()) throw new Error('invalid-response');
    parts.push(value);
  }
  if (!parts.length) throw new Error('invalid-response');
  const text = parts.join('').trim();
  if (!text || text === 'undefined') throw new Error('empty-response');
  return text;
}
// Shared counters contain only fixed error categories/codes, never chat, names or URLs.
const transportStats = { attempts: 0, retries: 0, recovered: 0, failures: 0, lastError: '', lastResult: '' };
let preferIPv4Until = 0;
function diagnosticCode(error) {
  const code = error && error.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,48}$/.test(code) ? code : '';
}
function createProvider({ timeoutMs = 3000 } = {}) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 2 });
  const active = new Map();
  let closed = false;
  return {
    availability,
    policy: requestPolicy,
    diagnostics() {
      const state = availability(), policy = requestPolicy();
      return { ...transportStats, family: Date.now() < preferIPv4Until ? 'ipv4' : 'auto',
        rateLimits: rate.hits, rateLimitStreak: rate.streak, recoveryProbes: rate.probes, rateRecovered: rate.recovered,
        rateMode: !state.available ? (rate.probe ? 'probe' : 'paused') : rate.limited ? 'probe-ready' : rate.successes < 20 ? 'recovering' : 'normal',
        pacingMs: policy.spacingMs, concurrency: policy.concurrency, retryAfterMs: state.retryAfterMs, pauseReason: state.reason };
    },
    translate(text, target, source) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new Error('closed'));
        const handle = {}, permit = acquire(handle, timeoutMs);
        if (!permit) return reject(new Error('service-cooldown'));
        const url = new URL('https://translate.googleapis.com/translate_a/single');
        for (const [key, value] of Object.entries({ client: 'gtx', sl: source, tl: target, dt: 't', dj: '1', q: text }))
          url.searchParams.set(key, value);
        const deadline = Date.now() + timeoutMs;
        let settled = false, timer = null, connectTimer = null, currentReq = null, attempts = 0;
        const finish = (error, result) => {
          if (settled) return;
          settled = true; clearTimeout(timer); clearTimeout(connectTimer); active.delete(handle);
          release(permit, error);
          if (error && !closed && error.message !== 'closed') {
            transportStats.failures++; transportStats.lastResult = 'failed';
            transportStats.lastError = error.message + (error.code ? ':' + error.code : '');
            if (['network-error', 'timeout', 'response-error', 'response-aborted'].includes(error.message)) {
              if (++networkFailures >= 2) pause('network-error', 5000);
            }
          } else if (!error) {
            networkFailures = 0;
            transportStats.lastResult = attempts > 1 ? 'recovered' : 'ok';
            if (attempts > 1) { transportStats.recovered++; preferIPv4Until = Date.now() + 60000; }
          }
          if (error) { if (currentReq) currentReq.destroy(); reject(error); } else resolve(result);
        };
        const fail = (reason, code = '') => {
          const error = new Error(reason); if (code) error.code = code;
          finish(error);
        };
        active.set(handle, () => fail('closed'));
        timer = setTimeout(() => fail('timeout'), timeoutMs);
        const attempt = fresh => {
          if (settled || closed) return;
          attempts++; transportStats.attempts++;
          let ended = false, req = null;
          const failed = (reason, code = '') => {
            if (ended || settled) return;
            ended = true; clearTimeout(connectTimer);
            if (req) req.destroy();
            // Only transport failures can retry. Never retry HTTP limits, bad
            // translations or TLS certificate errors, and never change provider.
            const retryable = reason !== 'network-error' || !code ||
              ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
            transportStats.lastError = reason + (code ? ':' + code : '');
            if (!fresh && retryable && !closed && Date.now() < deadline && mayRetry(permit)) {
              transportStats.retries++; attempt(true);
            } else fail(reason, code);
          };
          // A fresh IPv4 connection recovers stale pooled sockets and a stalled
          // IPv6/TLS handshake. The overall request still cannot exceed 3s.
          const options = { agent: fresh ? false : agent };
          if (fresh || Date.now() < preferIPv4Until) options.family = 4;
          try {
            req = https.get(url, options, response => {
              if (ended || settled || closed) { response.on('error', () => {}); response.destroy(); return; }
              clearTimeout(connectTimer);
              response.on('error', error => failed('response-error', diagnosticCode(error)));
              response.on('aborted', () => failed('response-aborted'));
              const status = response.statusCode;
              if (status !== 200) {
                ended = true;
                if (status === 429) {
                  limited(permit, response.headers['retry-after']);
                } else if (status === 403) pause('http-403', 60000);
                else if (status >= 500) pause('http-' + status, 5000);
                fail('http-' + status); response.destroy(); return;
              }
              let size = 0, body = '';
              response.setEncoding('utf8');
              response.on('data', chunk => {
                if (ended || settled) return;
                size += Buffer.byteLength(chunk);
                if (size > 262144) { ended = true; fail('oversized-response'); response.destroy(); return; }
                body += chunk;
              });
              response.on('end', () => {
                if (ended || settled) return;
                ended = true;
                try { finish(null, extractTranslation(body)); } catch (_) { fail('invalid-response'); }
              });
            });
            currentReq = req;
            req.on('error', error => failed('network-error', diagnosticCode(error)));
            if (!fresh) {
              // Do not cut a slow translation response in half: this early
              // timeout covers connection establishment only, not body time.
              connectTimer = setTimeout(() => failed('timeout'), Math.min(1200, timeoutMs / 2));
              req.on('socket', socket => {
                if (ended || settled) return;
                if (socket.encrypted && socket.authorized && !socket.connecting) clearTimeout(connectTimer);
                else socket.once('secureConnect', () => { if (!ended && !settled) clearTimeout(connectTimer); });
              });
            }
          } catch (error) { failed('network-error', diagnosticCode(error)); }
        };
        attempt(false);
      });
    },
    // Settle explicitly: an intentional close must never trigger retries or
    // poison the shared network backoff, even if destroy emits only close.
    close() { if (closed) return; closed = true; for (const cancel of active.values()) cancel(); active.clear(); agent.destroy(); }
  };
}
class TranslationService {
  constructor(provider, { timeoutMs = 4000, spacingMs = 200, cacheLimit = 256, cacheTtlMs = 900000, cache = new Map() } = {}) {
    this.provider = provider; this.timeoutMs = timeoutMs; this.spacingMs = spacingMs;
    this.cacheLimit = cacheLimit; this.cacheTtlMs = cacheTtlMs;
    this.queue = []; this.pending = new Map(); this.cache = cache; this.running = 0; this.priorityStarts = 0;
    this.nextStart = 0; this.timer = null; this.closed = false;
    this.stats = { requests: 0, hits: 0, shared: 0, failures: 0, timeouts: 0, unavailable: 0, overloaded: 0 };
  }
  availability() { return this.provider.availability ? this.provider.availability() : { available: true, retryAfterMs: 0, reason: '' }; }
  translate(text, target, source = 'auto', priority = false) {
    target = language(target); source = language(source, true);
    if (this.closed || !target || !source || typeof text !== 'string' || !text || text.length > 1200) return Promise.resolve(null);
    if (source === target) return Promise.resolve(text);
    const key = JSON.stringify([source, target, text]);
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) {
      this.cache.delete(key); this.cache.set(key, cached);
      this.stats.hits++; return Promise.resolve(cached.text);
    }
    this.cache.delete(key);
    if (this.pending.has(key)) {
      const existing = this.pending.get(key); existing.priority = existing.priority || priority;
      this.stats.shared++; return existing.promise;
    }
    if (!this.availability().available) { this.stats.unavailable++; return Promise.resolve(null); }
    // Reserve eight slots for outgoing messages during busy incoming chat.
    if (this.pending.size >= (priority ? 32 : 24)) { this.stats.overloaded++; return Promise.resolve(null); }
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const job = { key, text, target, source, priority, resolve, promise, done: false, timer: null };
    job.timer = setTimeout(() => { this.stats.timeouts++; this.finish(job, null); this.pump(); }, this.timeoutMs);
    this.pending.set(key, job); this.queue.push(job); this.pump(); return promise;
  }
  finish(job, result) {
    if (job.done) return;
    job.done = true; clearTimeout(job.timer); this.pending.delete(job.key);
    if (result && !this.closed) {
      this.cache.set(job.key, { text: result, until: Date.now() + this.cacheTtlMs });
      while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
    }
    job.resolve(this.closed ? null : result);
  }
  pump() {
    if (this.closed) return;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.queue = this.queue.filter(job => !job.done);
    if (!this.availability().available) {
      const queued = this.queue; this.queue = [];
      for (const job of queued) { this.stats.unavailable++; this.finish(job, null); }
      return;
    }
    const policy = this.provider.policy ? this.provider.policy() : {};
    const concurrency = Math.max(1, Math.min(2, Number(policy.concurrency) || 2));
    if (this.running >= concurrency || !this.queue.length) return;
    const wait = Math.max(0, this.nextStart - Date.now(), (Number(policy.nextStartAt) || 0) - Date.now());
    if (wait > 0) { this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait); return; }
    let index = this.queue.findIndex(job => this.priorityStarts >= 3 ? !job.priority : job.priority);
    if (index < 0) index = 0;
    const job = this.queue.splice(index, 1)[0];
    this.priorityStarts = job.priority ? this.priorityStarts + 1 : 0;
    this.running++; this.stats.requests++; this.nextStart = Date.now() + Math.max(this.spacingMs, Number(policy.spacingMs) || 0);
    Promise.resolve().then(() => this.provider.translate(job.text, job.target, job.source))
      .then(text => this.finish(job, text), error => {
        if (!job.done) this.stats[error && error.message === 'service-cooldown' ? 'unavailable' : 'failures']++;
        this.finish(job, null);
      })
      .finally(() => { this.running--; this.pump(); });
    this.pump();
  }
  close({ clearCache = true } = {}) {
    this.closed = true; clearTimeout(this.timer); this.timer = null;
    for (const job of this.pending.values()) this.finish(job, null);
    this.pending.clear(); this.queue = []; if (clearCache) this.cache.clear(); this.provider.close();
  }
}
module.exports = { language, extractTranslation, createProvider, TranslationService };
