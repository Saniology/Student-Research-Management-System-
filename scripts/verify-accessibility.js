#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const failures = [];

function pass(message) {
  console.log(`PASS   ${message}`);
}

function fail(message) {
  failures.push(message);
  console.log(`FAIL   ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function attrs(tag) {
  const result = {};
  [...tag.matchAll(/\s([:\w-]+)(?:="([^"]*)")?/g)].forEach((match) => {
    result[match[1]] = match[2] ?? true;
  });
  return result;
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function staticTags(name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => ({
    tag: match[0],
    index: match.index,
  }));
}

function staticButtonBlocks() {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gi)].map((match) => ({
    block: match[0],
    tag: match[0].match(/<button\b[^>]*>/i)?.[0] || '',
  }));
}

function hasNearbyLabel(id, index) {
  if (!id) return false;
  if (new RegExp(`<label\\b[^>]*for="${id}"`, 'i').test(html)) return true;
  const nearby = html.slice(Math.max(0, index - 220), index);
  return /<label\b[^>]*>[^<]+<\/label>\s*(?:<[^>]+>\s*){0,2}$/i.test(nearby);
}

function checkDocumentMetadata() {
  assert(/<html\b[^>]*lang="en"/i.test(html), 'document language is declared');
  assert(/<title>[^<]+<\/title>/i.test(html), 'document title is present');
  assert(/<meta\s+name="viewport"/i.test(html), 'viewport meta is present');
}

function checkImages() {
  const missing = staticTags('img')
    .map(({ tag }) => ({ tag, attr: attrs(tag) }))
    .filter(({ attr }) => !String(attr.alt || '').trim())
    .map(({ attr, tag }) => attr.id || tag.slice(0, 80));
  assert(missing.length === 0, `static images have alt text${missing.length ? ` missing: ${missing.join(', ')}` : ''}`);
}

function checkFormControls() {
  const controls = ['input', 'select', 'textarea'].flatMap(staticTags);
  const missing = controls
    .map(({ tag, index }) => ({ tag, index, attr: attrs(tag) }))
    .filter(({ attr }) => attr.type !== 'hidden')
    .filter(({ attr, index }) => {
      if (attr['aria-label'] || attr['aria-labelledby'] || attr.title) return false;
      return !hasNearbyLabel(attr.id, index);
    })
    .map(({ attr, tag }) => attr.id || tag.slice(0, 80));
  assert(missing.length === 0, `form controls have accessible labels${missing.length ? ` missing: ${missing.join(', ')}` : ''}`);
}

function checkButtons() {
  const missing = staticButtonBlocks()
    .map(({ block, tag }) => ({ text: stripTags(block), attr: attrs(tag), tag }))
    .filter(({ text, attr }) => !text && !attr['aria-label'] && !attr.title)
    .map(({ attr, tag }) => attr.id || tag.slice(0, 80));
  assert(missing.length === 0, `buttons have accessible names${missing.length ? ` missing: ${missing.join(', ')}` : ''}`);
}

function checkFocusAndResponsiveBasics() {
  assert(!/outline:\s*none/i.test(html) || /:focus/i.test(html), 'focus styling is not globally removed without replacement');
  assert(!/letter-spacing:\s*-\d/i.test(html), 'negative letter spacing is absent');
  assert(!/text-\[[^\]]*vw[^\]]*\]/.test(html), 'font sizes do not scale directly with viewport width');
}

checkDocumentMetadata();
checkImages();
checkFormControls();
checkButtons();
checkFocusAndResponsiveBasics();

console.log('');
console.log(`Accessibility verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
