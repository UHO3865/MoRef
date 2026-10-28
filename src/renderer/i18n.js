'use strict';
/* global I18N_STRINGS */
// 화면 글자 번역: 한국어(원문) / English / 日本語
//
//  * 키는 한국어 원문이고, {0} {1} … 은 끼워 넣을 값이다. 사전(i18n-strings.js)에 없으면 한국어 그대로 보인다.
//  * 언어는 창을 열 때 주소(?lang=)로 받는다 → 다른 화면 코드가 실행되기 전에 정해진다.
//  * index.html 의 고정 글자는 여기서 바로 바꾼다 (이 스크립트는 다른 화면 스크립트보다 먼저, 본문 다음에 실행된다).
//    - title / placeholder / aria-label / alt 속성
//    - 글자와 굵게·줄바꿈 같은 꾸밈 태그만 있는 요소는 innerHTML 통째로, 아니면 글자 조각마다

const LANG = (() => {
  const q = new URLSearchParams(location.search).get('lang');
  return ['ko', 'en', 'ja'].includes(q) ? q : 'ko';
})();
document.documentElement.lang = LANG;

function tr(ko, ...args) {
  const dict = LANG === 'ko' ? null : I18N_STRINGS[LANG];
  const s = (dict && dict[ko]) || ko;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[i] ?? '')) : s;
}

const I18N_HANGUL = /[가-힣]/;
const I18N_INLINE = new Set(['B', 'I', 'EM', 'STRONG', 'KBD', 'CODE', 'BR', 'SMALL']);
const I18N_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

// 바꿀 자리들: [{ el, attr } | { el, html } | { node }] 과 그 키
function i18nTargets(root) {
  const out = [];
  const walk = (el) => {
    for (const a of I18N_ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && I18N_HANGUL.test(v)) out.push({ el, attr: a, key: v });
    }
    const kids = [...el.childNodes];
    const hasText = kids.some((n) => n.nodeType === 3 && I18N_HANGUL.test(n.nodeValue));
    const inlineOnly = kids.every((n) => n.nodeType === 3 || (n.nodeType === 1 && I18N_INLINE.has(n.tagName)));
    if (hasText && inlineOnly && kids.some((n) => n.nodeType === 1)) {
      out.push({ el, html: true, key: el.innerHTML.replace(/\s+/g, ' ').trim() });
      return;
    }
    for (const n of kids) {
      if (n.nodeType === 3 && I18N_HANGUL.test(n.nodeValue)) out.push({ node: n, key: n.nodeValue.replace(/\s+/g, ' ').trim() });
      else if (n.nodeType === 1 && n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE') walk(n);
    }
  };
  walk(root);
  return out;
}

function translateDom(root = document.body) {
  if (LANG === 'ko') return;
  for (const t of i18nTargets(root)) {
    const v = tr(t.key);
    if (v === t.key) continue;
    if (t.attr) t.el.setAttribute(t.attr, v);
    else if (t.html) t.el.innerHTML = v;
    else t.node.nodeValue = t.node.nodeValue.replace(/\S[\s\S]*\S|\S/, v); // 앞뒤 공백은 그대로
  }
}

// 사전 만들 때: 고정 글자의 키 목록 (?i18nDump=1)
if (new URLSearchParams(location.search).has('i18nDump')) window.I18N_STATIC_KEYS = i18nTargets(document.body).map((t) => t.key);
translateDom();
document.title = tr(document.title);
