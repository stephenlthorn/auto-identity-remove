'use strict';
/**
 * test/helpers/mini-yaml.js
 *
 * A very small YAML reader, just enough for .github/workflows/*.yml as this repo
 * writes them: block mappings, block lists (including lists of mappings), plain
 * and quoted scalars, and `|` block scalars. No anchors, no flow collections, no
 * multi-document files. It exists so the workflow test can assert per job and
 * per step without adding a dependency; it throws on anything it does not
 * understand instead of guessing, so a workflow written in a fancier style fails
 * the test loudly rather than passing it by accident.
 *
 * Not a test file (no .test.js suffix).
 */

function unquote(raw) {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) return v.slice(1, -1);
  return v;
}

// "key: value" or "key:". The key is everything up to the first ": " (or a trailing colon).
function splitKey(text) {
  const match = text.match(/^([A-Za-z0-9_.\-/]+|'[^']*'|"[^"]*")\s*:(?:\s+(.*))?$/);
  if (!match) throw new Error(`mini-yaml: cannot read "${text}"`);
  return { key: unquote(match[1]), rest: match[2] === undefined ? '' : match[2] };
}

function parse(source) {
  const raw = source.split('\n');
  let at = 0;

  const indentOf = (line) => line.match(/^ */)[0].length;
  const skipNoise = () => {
    while (at < raw.length && (raw[at].trim() === '' || /^\s*#/.test(raw[at]))) at += 1;
  };

  function readBlockScalar(parentIndent) {
    const body = [];
    let blockIndent = null;
    while (at < raw.length) {
      const line = raw[at];
      if (line.trim() === '') { body.push(''); at += 1; continue; }
      const indent = indentOf(line);
      if (indent <= parentIndent) break;
      if (blockIndent === null) blockIndent = indent;
      body.push(line.slice(Math.min(blockIndent, indent)));
      at += 1;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    return `${body.join('\n')}\n`;
  }

  function readValue(rest, keyIndent) {
    if (/^[|>][+-]?$/.test(rest.trim())) return readBlockScalar(keyIndent);
    if (rest.trim() === '') return readBlock(keyIndent);
    if (/^[[{]/.test(rest.trim())) throw new Error(`mini-yaml: flow collections are not supported: ${rest}`);
    return unquote(rest.replace(/\s+#.*$/, ''));
  }

  // The block that starts at the next real line, if it is indented deeper than `parentIndent`.
  function readBlock(parentIndent) {
    skipNoise();
    if (at >= raw.length) return null;
    const indent = indentOf(raw[at]);
    if (indent <= parentIndent) return null;
    return /^\s*- /.test(raw[at]) || /^\s*-$/.test(raw[at]) ? readList(indent) : readMap(indent);
  }

  function readMap(indent, firstLineText) {
    const map = {};
    let first = firstLineText;
    for (;;) {
      let text;
      if (first !== undefined) { text = first; first = undefined; } else {
        skipNoise();
        if (at >= raw.length || indentOf(raw[at]) !== indent || /^\s*-( |$)/.test(raw[at])) break;
        text = raw[at].trim();
        at += 1;
      }
      const { key, rest } = splitKey(text);
      if (key in map) throw new Error(`mini-yaml: duplicate key "${key}"`);
      map[key] = readValue(rest, indent);
    }
    return map;
  }

  function readList(indent) {
    const list = [];
    for (;;) {
      skipNoise();
      if (at >= raw.length || indentOf(raw[at]) !== indent || !/^\s*-( |$)/.test(raw[at])) break;
      const text = raw[at].trim().slice(1).trim();
      at += 1;
      if (text === '') { list.push(readBlock(indent)); continue; }
      if (/^[A-Za-z0-9_.\-/'"]+\s*:(\s|$)/.test(text)) {
        // "- key: value": the mapping's other keys sit at the column of "key".
        const itemIndent = indent + 2;
        list.push(readMapItem(itemIndent, text));
      } else {
        list.push(unquote(text));
      }
    }
    return list;
  }

  function readMapItem(itemIndent, firstText) {
    const { key, rest } = splitKey(firstText);
    const map = {};
    map[key] = readValue(rest, itemIndent);
    skipNoise();
    if (at < raw.length && indentOf(raw[at]) === itemIndent && !/^\s*-( |$)/.test(raw[at])) {
      Object.assign(map, readMap(itemIndent));
    }
    return map;
  }

  skipNoise();
  const result = readMap(indentOf(raw[at] || ''));
  skipNoise();
  if (at < raw.length) throw new Error(`mini-yaml: could not read line ${at + 1}: ${raw[at]}`);
  return result;
}

module.exports = { parse };
