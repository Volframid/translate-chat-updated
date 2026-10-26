'use strict';
const { language } = require('./translate');
module.exports = function migrate(from, to, settings) {
  const values = settings && typeof settings === 'object' ? settings : {};
  return {
    enabled: typeof values.enabled === 'boolean' ? values.enabled : true,
    sourceLang: language(values.sourceLang, true) || 'auto',
    targetLang: language(values.targetLang) || 'en',
    sendMode: typeof values.sendMode === 'boolean' ? values.sendMode : false,
    sendLang: language(values.sendLang) || 'en'
  };
};
