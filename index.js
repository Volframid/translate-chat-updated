'use strict';
const { language, createProvider, TranslationService } = require('./lib/translate');
const { prepare } = require('./lib/format');
const migrate = require('./lib/setting_migration');
module.exports = class Translator {
  constructor(mod) {
    this.mod = mod; this.closed = false; this.epoch = 0; this.lanes = new Map(); this.count = 0;
    this.stats = { incoming: 0, outgoing: 0, translated: 0, originals: 0, skipped: 0, deliveryFailures: 0, unchanged: 0 };
    this.serviceTotals = {}; this.lastDeliveryWarning = null;
    mod.settings = migrate(null, 3, mod.settings);
    this.service = new TranslationService(createProvider());
    this.changeSession = () => this.reset(false);
    this.onLoading = () => this.reset(true);
    mod.game.on('enter_character_lobby', this.changeSession);
    mod.game.on('leave_game', this.changeSession);
    mod.game.on('leave_loading_screen', this.onLoading);
    this.addCommand();
    for (const [name, version] of [['S_CHAT', mod.majorPatchVersion >= 108 ? 4 : 3], ['S_WHISPER', mod.majorPatchVersion >= 108 ? 4 : 3], ['S_PRIVATE_CHAT', 1]])
      mod.hook(name, version, { order: 100, filter: { fake: false, silenced: false } }, event => this.incoming(name, version, event));
    // Run after command rejection, so an unknown Toolbox command cannot
    // accidentally become a real chat message through async translation.
    for (const [name, version] of [['C_CHAT', 1], ['C_WHISPER', mod.majorPatchVersion >= 108 ? 2 : 1]])
      mod.hook(name, version, { order: 100, filter: { fake: false, silenced: false } }, event => this.outgoing(name, version, event));
  }
  self(event) {
    if (event.gameId !== undefined && this.mod.game.me.is(event.gameId)) return true;
    const name = event.name || event.authorName || event.senderName;
    return name && this.mod.game.me.name && name === this.mod.game.me.name;
  }
  key(name, event, outgoing) {
    const peer = name.includes('WHISPER') ? event.name || event.recipient || event.senderName || '' : event.channel ?? event.channelId ?? '';
    return (outgoing ? 'out:' : 'in:') + name + ':' + String(peer);
  }
  incoming(name, version, event) {
    if (this.closed || !this.mod.settings.enabled || this.self(event)) return;
    this.stats.incoming++; this.enqueue(name, version, event, false);
  }
  outgoing(name, version, event) {
    if (this.closed || !this.mod.settings.enabled || !this.mod.settings.sendMode) return;
    if (this.count >= 64) this.flushOutgoing();
    if (!this.enqueue(name, version, event, true)) {
      const key = this.key(name, event, true);
      const lane = this.lanes.get(key);
      if (lane) {
        for (const job of lane) { clearTimeout(job.timer); if (job.request.cancel) job.request.cancel(); job.done = true; job.text = null; }
        this.drain(key);
      }
      return;
    }
    this.stats.outgoing++; return false;
  }
  enqueue(name, version, event, outgoing) {
    if (this.count >= 64) { this.stats.skipped++; return false; }
    const message = prepare(event.message, [event.name, event.authorName, event.senderName]);
    if (!message || !message.translatable) { this.stats.skipped++; return false; }
    const target = outgoing ? this.mod.settings.sendLang : this.mod.settings.targetLang;
    const source = outgoing ? 'auto' : this.mod.settings.sourceLang;
    const key = this.key(name, event, outgoing);
    let lane = this.lanes.get(key);
    if (!lane) { lane = []; this.lanes.set(key, lane); }
    const job = { name, version, event: { ...event }, outgoing, target, epoch: this.epoch, done: false, text: null, timer: null, request: null };
    lane.push(job); this.count++;
    const complete = text => {
      if (job.done || this.closed || job.epoch !== this.epoch) return;
      job.done = true; job.text = text; clearTimeout(job.timer);
      if (job.request.cancel) job.request.cancel('deadline');
      this.drain(key);
    };
    const timeoutMs = outgoing ? 4000 : 10000;
    job.request = this.service.translate(message.text, target, source, outgoing, {
      timeoutMs, retry: !outgoing, validate: text => message.restore(text) !== null
    });
    job.timer = setTimeout(() => complete(null), timeoutMs);
    job.request.then(translated => {
      if (job.done || this.closed || job.epoch !== this.epoch) return;
      let text = translated === message.text ? null : message.restore(translated, target);
      if (text && text.replace(/\s+/g, ' ').trim() === message.restore(message.text).replace(/\s+/g, ' ').trim()) text = null;
      if (translated && !text) this.stats.unchanged++;
      complete(text);
    }).catch(() => complete(null));
    return true;
  }
  drain(key) {
    const lane = this.lanes.get(key);
    while (lane && this.lanes.get(key) === lane && lane.length && lane[0].done) {
      const job = lane.shift(); this.count--; clearTimeout(job.timer);
      if (this.closed || job.epoch !== this.epoch) continue;
      if (job.outgoing || job.text) this.deliver(job);
    }
    if (lane && this.lanes.get(key) === lane && !lane.length) this.lanes.delete(key);
  }
  deliveryFailure() {
    this.stats.deliveryFailures++;
    const now = Date.now();
    if (this.lastDeliveryWarning === null || now - this.lastDeliveryWarning >= 30000) {
      this.lastDeliveryWarning = now;
      if (this.mod.warn) this.mod.warn('Chat delivery failed or was blocked. Check connection and other chat modules; no automatic resend.');
    }
  }
  deliver(job) {
    let translated = Boolean(job.text);
    let event = translated ? { ...job.event, message: job.outgoing ? '<FONT>' + job.text + '</FONT>' : '<FONT color="#88DDFF">[' + job.target.toUpperCase() + '] ' + job.text + '</FONT>' } : job.event;
    // Preflight encoding before sending. Only an encoding failure is safe
    // to fall back from; never resend a packet blocked by another module.
    if (translated && this.mod.dispatch && typeof this.mod.dispatch.toRaw === 'function') {
      try { this.mod.dispatch.toRaw(job.name, job.version, event); }
      catch (_) {
        if (!job.outgoing) { this.deliveryFailure(); return; }
        translated = false; event = job.event;
      }
    }
    try {
      if (this.mod.send(job.name, job.version, event) === false) { this.deliveryFailure(); return; }
      if (translated) this.stats.translated++; else this.stats.originals++;
    } catch (_) { this.deliveryFailure(); }
  }
  flushOutgoing() {
    for (const [key, lane] of this.lanes) if (key.startsWith('out:')) {
      for (const job of lane) { clearTimeout(job.timer); if (job.request.cancel) job.request.cancel(); job.done = true; job.text = null; }
      this.drain(key);
    }
  }
  reset(deliverOriginals) {
    if (deliverOriginals && !this.closed) this.flushOutgoing();
    this.epoch++;
    for (const lane of this.lanes.values()) for (const job of lane) clearTimeout(job.timer);
    this.lanes.clear(); this.count = 0;
    const cache = deliverOriginals ? this.service.cache : undefined;
    for (const [key, value] of Object.entries(this.service.stats)) this.serviceTotals[key] = (this.serviceTotals[key] || 0) + value;
    this.service.close({ clearCache: !deliverOriginals });
    if (!this.closed) this.service = new TranslationService(createProvider(), { cache });
  }
  message(text) { this.mod.command.message(text); }
  save() { this.mod.saveSettings(); }
  addCommand() {
    const toggle = enabled => { this.reset(true); this.mod.settings.enabled = enabled; this.save(); this.status(); };
    this.mod.command.add('translate', {
      $default: () => toggle(!this.mod.settings.enabled),
      on: () => toggle(true), off: () => toggle(false), status: () => this.status(),
      source: id => this.setLanguage('sourceLang', id, true),
      target: id => this.setLanguage('targetLang', id, false),
      // Outgoing settings must not cancel incoming jobs or replace their provider.
      send: id => {
        if (id === undefined || ['on', 'off'].includes(String(id).toLowerCase())) {
          this.flushOutgoing(); this.mod.settings.sendMode = id === undefined ? !this.mod.settings.sendMode : String(id).toLowerCase() === 'on';
        } else {
          const code = language(id); if (!code) return this.message('Invalid language. Examples: en, tr, ru.');
          this.flushOutgoing(); this.mod.settings.sendLang = code; this.mod.settings.sendMode = true;
        }
        this.save(); this.status();
      },
      diagnose: () => this.diagnose(),
      stats: () => {
        const total = key => (this.serviceTotals[key] || 0) + (this.service.stats[key] || 0);
        this.message('Incoming ' + this.stats.incoming + ' | outgoing ' + this.stats.outgoing + ' | skipped ' + this.stats.skipped + ' | requests ' + total('requests') + ' | translated ' + this.stats.translated + ' | original fallback ' + this.stats.originals +
          ' | cache hits ' + total('hits') + ' | failures ' + total('failures') + ' | timeouts ' + total('timeouts') +
          ' | unavailable ' + total('unavailable') + ' | overloaded ' + total('overloaded') +
          ' | delivery failures ' + this.stats.deliveryFailures + ' | pending ' + this.count);
        this.message('Incoming retries ' + total('retries') + ' | recovered ' + total('recovered') +
          ' | invalid results ' + total('invalid') + ' | queue expired ' + total('queueExpired') +
          ' | canceled ' + total('canceled') + ' | unchanged ' + this.stats.unchanged);
      },
      help: () => this.message('translate on/off | source auto/en/tr/ru | target en/tr/ru | send en/tr/ru/on/off | status | stats | diagnose')
    });
  }
  setLanguage(field, id, source) {
    if (id === undefined) return this.message(field + ': ' + this.mod.settings[field]);
    const code = language(id, source); if (!code) return this.message('Invalid language. Examples: ' + (source ? 'auto, ' : '') + 'en, tr, ru.');
    this.reset(true); this.mod.settings[field] = code; this.save(); this.status();
  }
  diagnose() {
    const provider = this.service.provider;
    const info = provider.diagnostics ? provider.diagnostics() : null;
    if (!info) return this.message('Network diagnostics unavailable.');
    this.message('Translate 1.0.8 | Google HTTPS | network ' + info.family + ' | attempts ' + info.attempts +
      ' | retries ' + info.retries + ' | recovered ' + info.recovered + ' | failed requests ' + info.failures +
      ' | last result ' + (info.lastResult || 'none') + ' | last issue ' + (info.lastError || 'none'));
    this.message('HTTP429 ' + info.rateLimits + ' | backoff level ' + info.rateLimitStreak + ' | mode ' + info.rateMode +
      ' | pacing ' + info.pacingMs + 'ms | recovery probes ' + info.recoveryProbes + ' | recovered ' + info.rateRecovered +
      ' | pause ' + Math.ceil(info.retryAfterMs / 1000) + 's' + (info.pauseReason ? ' (' + info.pauseReason + ')' : ''));
  }
  status() {
    const state = this.service.availability ? this.service.availability() : { available: true };
    this.message('Translate ' + (this.mod.settings.enabled ? 'ON' : 'OFF') + ' | ' + this.mod.settings.sourceLang + ' -> ' + this.mod.settings.targetLang +
      ' | send ' + (this.mod.settings.sendMode ? this.mod.settings.sendLang : 'OFF') +
      (!state.available ? ' | service paused ' + Math.ceil(state.retryAfterMs / 1000) + 's (' + state.reason + ')' : ''));
  }
  destructor() {
    if (this.closed) return;
    this.closed = true; this.reset(false);
    for (const [name, handler] of [['enter_character_lobby', this.changeSession], ['leave_game', this.changeSession], ['leave_loading_screen', this.onLoading]])
      this.mod.game.removeListener(name, handler);
    this.mod.command.remove('translate');
  }
};
