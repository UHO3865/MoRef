// 메인 프로세스의 번역 (화면과 같은 사전: renderer/i18n-strings.js)
// 언어: 설정에 고른 것이 있으면 그것, 없으면 Windows 언어 (한국어 → ko, 일본어 → ja, 그 밖 → en)
const { app } = require('electron');
const STRINGS = require('./renderer/i18n-strings.js');

const LANGS = ['ko', 'en', 'ja'];
let lang = 'ko';

function resolveLang(settings = {}) {
  if (LANGS.includes(settings.language)) return settings.language;
  const loc = (app.getLocale() || '').toLowerCase();
  return loc.startsWith('ko') ? 'ko' : loc.startsWith('ja') ? 'ja' : 'en';
}

function setLang(l) {
  lang = LANGS.includes(l) ? l : 'ko';
}

function tr(ko, ...args) {
  const s = (lang !== 'ko' && STRINGS[lang] && STRINGS[lang][ko]) || ko;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[i] ?? '')) : s;
}

module.exports = { LANGS, resolveLang, setLang, getLang: () => lang, tr };
