'use strict';
const https = require('https');
let cooldownUntil = 0;
let cooldownReason = '', networkFailures = 0;
function availability() {
  const retryAfterMs = Math.max(0, cooldownUntil - Date.now());
  return { available: retryAfterMs === 0, retryAfterMs, reason: retryAfterMs ? cooldownReason : '' };
}
function pause(reason, delay) {
  const until = Date.now() + delay;
  if (until > cooldownUntil) { cooldownUntil = until; cooldownReason = reason; }
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
function createProvider({ timeoutMs = 3000 } = {}) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 2 });
  const active = new Map();
  let closed = false;
  return {
    availability,
    translate(text, target, source) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new Error('closed'));
        if (Date.now() < cooldownUntil) return reject(new Error('service-cooldown'));
        const url = new URL('https://translate.googleapis.com/translate_a/single');
        for (const [key, value] of Object.entries({ client: 'gtx', sl: source, tl: target, dt: 't', dj: '1', q: text }))
          url.searchParams.set(key, value);
        let settled = false, timer = null, req = null;
        const finish = (error, result) => {
          if (settled) return;
          settled = true; clearTimeout(timer); active.delete(req);
          if (error && !closed && ['network-error', 'timeout', 'response-error', 'response-aborted'].includes(error.message)) {
            if (++networkFailures >= 2) pause('network-error', 5000);
          } else if (!error) networkFailures = 0;
          if (error) reject(error); else resolve(result);
        };
        req = https.get(url, { agent }, response => {
          const failedResponse = reason => {
            if (settled) return;
            finish(new Error(reason)); req.destroy();
          };
          response.on('error', () => failedResponse('response-error'));
          response.on('aborted', () => failedResponse('response-aborted'));
          if (settled || closed) { response.destroy(); return; }
          const status = response.statusCode;
          if (status !== 200) {
            if (status === 429) {
              const value = response.headers['retry-after'];
              const seconds = Number(value), date = Date.parse(value);
              const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 0;
              pause('http-429', Math.max(60000, Number.isFinite(delay) ? delay : 0));
            } else if (status === 403) pause('http-403', 60000);
            else if (status >= 500) pause('http-' + status, 5000);
            finish(new Error('http-' + status)); response.destroy(); req.destroy(); return;
          }
          let size = 0, body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => {
            if (settled) return;
            size += Buffer.byteLength(chunk);
            if (size > 262144) { finish(new Error('oversized-response')); response.destroy(); req.destroy(); return; }
            body += chunk;
          });
          response.on('end', () => {
            if (settled) return;
            try { finish(null, extractTranslation(body)); } catch (_) { finish(new Error('invalid-response')); }
          });
        });
        active.set(req, () => { finish(new Error('closed')); req.destroy(); });
        req.on('error', () => finish(new Error(closed ? 'closed' : 'network-error')));
        timer = setTimeout(() => { finish(new Error('timeout')); req.destroy(); }, timeoutMs);
      });
    },
    // Some destroyed requests emit only close, not error. Settle them now and
    // cancel their timers so intentional shutdown cannot trigger shared backoff.
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
    if (this.running >= 2 || !this.queue.length) return;
    const wait = Math.max(0, this.nextStart - Date.now());
    if (wait > 0) { this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait); return; }
    let index = this.queue.findIndex(job => this.priorityStarts >= 3 ? !job.priority : job.priority);
    if (index < 0) index = 0;
    const job = this.queue.splice(index, 1)[0];
    this.priorityStarts = job.priority ? this.priorityStarts + 1 : 0;
    this.running++; this.stats.requests++; this.nextStart = Date.now() + this.spacingMs;
    Promise.resolve().then(() => this.provider.translate(job.text, job.target, job.source))
      .then(text => this.finish(job, text), () => { if (!job.done) this.stats.failures++; this.finish(job, null); })
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
