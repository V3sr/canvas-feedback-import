/*
 * CSV reading and writing.
 * Works as a classic content script (attaches to globalThis.CFI) and as a
 * CommonJS module for the Node tests.
 */
(function (root) {
  'use strict';

  // Decode raw file bytes. Handles UTF-8 (with/without BOM), Excel's
  // "Unicode Text" (UTF-16 LE/BE with BOM), and the Windows-1252 that Excel's
  // plain "CSV" save uses on Windows.
  function decodeBytes(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { text: stripBom(text), encoding: 'utf-8' };
    } catch (e) {
      const text = new TextDecoder('windows-1252').decode(bytes);
      return { text: stripBom(text), encoding: 'windows-1252' };
    }
  }

  function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  // Pick the delimiter from the first line: comma, semicolon (European Excel)
  // or tab (Unicode Text / TSV). Honors Excel's "sep=;" hint line.
  function detectDelimiter(text) {
    const sep = text.match(/^sep=(.)\r?\n/i);
    if (sep) return { delimiter: sep[1], skip: sep[0].length };
    let firstLine = '';
    let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') inQ = !inQ;
      else if (!inQ && (c === '\n' || c === '\r')) break;
      firstLine += inQ ? '' : c;
    }
    const counts = { ',': 0, ';': 0, '\t': 0 };
    for (const c of firstLine) if (c in counts) counts[c]++;
    let best = ',';
    for (const d of [';', '\t']) if (counts[d] > counts[best]) best = d;
    return { delimiter: best, skip: 0 };
  }

  // RFC 4180 style parser. Quotes only open at the start of a cell, so a
  // stray quote inside text (5" ruler) is kept as a character.
  function parse(text, delimiter) {
    let d = delimiter;
    if (!d) {
      const det = detectDelimiter(text);
      d = det.delimiter;
      text = text.slice(det.skip);
    }
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let atFieldStart = true;
    let i = 0;
    const n = text.length;

    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && atFieldStart) { inQuotes = true; atFieldStart = false; i++; continue; }
      if (c === d) { row.push(field); field = ''; atFieldStart = true; i++; continue; }
      if (c === '\r' || c === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
        atFieldStart = true;
        if (c === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      field += c; atFieldStart = false; i++;
    }
    if (inQuotes) {
      throw new Error('The file ends in the middle of a quoted cell, so it may have been cut off. Open it in Excel or Google Sheets and save it again as CSV.');
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    // Drop fully empty trailing rows (Excel often adds some).
    while (rows.length && rows[rows.length - 1].every((v) => v.trim() === '')) rows.pop();
    return rows;
  }

  function escapeField(value) {
    const s = value == null ? '' : String(value);
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // Stop a spreadsheet from treating text as a formula when the file is
  // opened (=, +, -, @ at the start). Only for free-text cells.
  function safeText(value) {
    const s = value == null ? '' : String(value);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  // Rows -> CSV text with a UTF-8 BOM so Excel opens accents correctly.
  function serialize(rows) {
    return '﻿' + rows.map((r) => r.map(escapeField).join(',')).join('\r\n') + '\r\n';
  }

  const api = { decodeBytes, parse, serialize, escapeField, detectDelimiter, safeText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CFI = root.CFI || {}; root.CFI.csv = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
