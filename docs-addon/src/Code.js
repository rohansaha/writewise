/**
 * WriteWise for Google Docs — server side (Google Apps Script).
 *
 * The grammar engine runs inside the sidebar (see Sidebar.html); these functions
 * are the only bridge to the document. They never call the network.
 * Scopes used: documents.currentonly (read/edit this document) and
 * script.container.ui (show the sidebar). MIT License — see the repository LICENSE.
 */

var SETTINGS_KEY = 'writewise.settings';
var MAX_SETTINGS_BYTES = 8000; // PropertiesService allows 9 KB per value.

/** Adds the add-on menu. Runs in AuthMode.NONE, so it must not touch the document. */
function onOpen(e) {
  DocumentApp.getUi().createAddonMenu().addItem('Open WriteWise', 'showSidebar').addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('WriteWise');
  DocumentApp.getUi().showSidebar(html);
}

function activeDocument_() {
  var doc = DocumentApp.getActiveDocument();
  if (!doc) throw new Error('Open WriteWise from inside a Google Doc.');
  return doc;
}

/**
 * Every paragraph of the body (list items included) with its position in
 * Body.getParagraphs(). Empty paragraphs are skipped; the index still refers to
 * the full list so applyFix can find the paragraph again.
 */
function getDocumentText() {
  var doc = activeDocument_();
  var paragraphs = doc.getBody().getParagraphs();
  var out = [];
  for (var i = 0; i < paragraphs.length; i++) {
    var text = paragraphs[i].editAsText().getText();
    if (text.length) out.push({ index: i, text: text });
  }
  return { paragraphs: out, count: paragraphs.length };
}

/**
 * Replaces [start, end) of one paragraph with `replacement`. `expected` is the
 * text the sidebar believes is there; if the document changed in the meantime
 * nothing is touched and the sidebar re-checks.
 */
function applyFix(paragraphIndex, start, end, replacement, expected) {
  return applyFixes([{ paragraphIndex: paragraphIndex, start: start, end: end, replacement: replacement, expected: expected }]);
}

/** Batch version used by "Fix all safe". Fixes may target any paragraphs in any order. */
function applyFixes(fixes) {
  if (!Array.isArray(fixes)) throw new Error('fixes must be an array');
  var doc = activeDocument_();
  var paragraphs = doc.getBody().getParagraphs();
  var byParagraph = {};
  fixes.forEach(function (f) {
    var key = String(f.paragraphIndex);
    (byParagraph[key] = byParagraph[key] || []).push(f);
  });
  var applied = 0, skipped = 0, updated = {};
  Object.keys(byParagraph).forEach(function (key) {
    var paragraph = paragraphs[Number(key)];
    var list = byParagraph[key];
    if (!paragraph) { skipped += list.length; return; }
    var text = paragraph.editAsText();
    var current = text.getText();
    // Right to left, so earlier offsets stay valid after each edit.
    list.sort(function (a, b) { return b.start - a.start; });
    var lastStart = Infinity;
    list.forEach(function (f) {
      var start = Number(f.start), end = Number(f.end), replacement = String(f.replacement == null ? '' : f.replacement);
      var valid = start >= 0 && end >= start && end <= current.length && end <= lastStart
        && (typeof f.expected !== 'string' || current.substring(start, end) === f.expected);
      if (!valid) { skipped++; return; }
      if (end > start) text.deleteText(start, end - 1);
      if (replacement) {
        if (start >= text.getText().length) text.appendText(replacement);
        else text.insertText(start, replacement);
      }
      current = current.substring(0, start) + replacement + current.substring(end);
      lastStart = start;
      applied++;
    });
    updated[key] = text.getText();
  });
  return { applied: applied, skipped: skipped, paragraphs: updated };
}

/** Highlights the flagged text in the document so the user can see it in context. */
function selectRange(paragraphIndex, start, end, expected) {
  var doc = activeDocument_();
  var paragraph = doc.getBody().getParagraphs()[paragraphIndex];
  if (!paragraph) return { ok: false };
  var text = paragraph.editAsText();
  var current = text.getText();
  if (typeof expected === 'string' && current.substring(start, end) !== expected) return { ok: false };
  var range = doc.newRange();
  if (end > start) range.addElement(text, start, end - 1); else range.addElement(paragraph);
  doc.setSelection(range.build());
  return { ok: true };
}

/**
 * Text that "Make it a prompt" should work on: the selection, else the paragraph
 * under the cursor, else the whole body.
 */
function getPromptSource() {
  var doc = activeDocument_();
  var selection = doc.getSelection();
  if (selection) {
    var parts = [];
    var elements = selection.getRangeElements();
    for (var i = 0; i < elements.length; i++) {
      var re = elements[i], el = re.getElement(), t = '';
      if (re.isPartial()) t = el.asText().getText().substring(re.getStartOffset(), re.getEndOffsetInclusive() + 1);
      else if (typeof el.getText === 'function') t = el.getText();
      if (t) parts.push(t);
    }
    var selected = parts.join('\n');
    if (selected.trim()) return { text: selected, scope: 'selection' };
  }
  var cursor = doc.getCursor();
  if (cursor) {
    var block = containingBlock_(cursor.getElement());
    if (block) {
      var child = block.parent.getChild(block.index);
      var paragraphText = typeof child.getText === 'function' ? child.getText() : '';
      if (paragraphText.trim()) return { text: paragraphText, scope: 'cursor' };
    }
  }
  return { text: doc.getBody().getText(), scope: 'document' };
}

/**
 * Inserts the structured prompt (one paragraph per line) below the selection,
 * below the cursor's paragraph, or at the end of the document. Lines that start
 * with "# " are made bold so the sections stand out; the text stays plain
 * Markdown so it can be pasted into any AI chat box as is.
 */
function insertPrompt(lines) {
  if (!Array.isArray(lines)) throw new Error('lines must be an array');
  var doc = activeDocument_();
  var body = doc.getBody();
  var anchor = findAnchor_(doc);
  var parent = anchor ? anchor.parent : body;
  var at = anchor ? anchor.index + 1 : parent.getNumChildren();
  var firstInserted = null;
  function insert(textLine) {
    var p = at >= parent.getNumChildren() ? parent.appendParagraph(textLine) : parent.insertParagraph(at, textLine);
    at++;
    p.setHeading(DocumentApp.ParagraphHeading.NORMAL);
    if (!firstInserted) firstInserted = p;
    return p;
  }
  insert(''); // blank line between the original text and the prompt
  for (var i = 0; i < lines.length; i++) {
    var line = String(lines[i]);
    var p = insert(line);
    if (line.indexOf('# ') === 0) p.editAsText().setBold(true);
  }
  try { doc.setCursor(doc.newPosition(firstInserted, 0)); } catch (err) { /* cursor placement is cosmetic */ }
  return { inserted: lines.length, scope: anchor ? anchor.scope : 'end' };
}

/** The last element of the selection, else the cursor element, resolved to its top-level block. */
function findAnchor_(doc) {
  var element = null, scope = null;
  var selection = doc.getSelection();
  if (selection) {
    var elements = selection.getRangeElements();
    if (elements.length) { element = elements[elements.length - 1].getElement(); scope = 'selection'; }
  }
  if (!element) {
    var cursor = doc.getCursor();
    if (cursor) { element = cursor.getElement(); scope = 'cursor'; }
  }
  if (!element) return null;
  var block = containingBlock_(element);
  if (block) block.scope = scope;
  return block;
}

/** Walks up to the child of a section that can hold paragraphs (body, table cell, header, footer, footnote). */
function containingBlock_(element) {
  var containers = [
    DocumentApp.ElementType.BODY_SECTION, DocumentApp.ElementType.TABLE_CELL, DocumentApp.ElementType.HEADER_SECTION,
    DocumentApp.ElementType.FOOTER_SECTION, DocumentApp.ElementType.FOOTNOTE_SECTION,
  ];
  var el = element;
  for (var depth = 0; el && depth < 50; depth++) {
    var parent = el.getParent();
    if (!parent) return null;
    if (containers.indexOf(parent.getType()) !== -1) return { parent: parent, index: parent.getChildIndex(el) };
    el = parent;
  }
  return null;
}

/** Per-user settings (mode, toggles, personal dictionary) stored with PropertiesService; no extra scope needed. */
function getSettings() {
  var raw = PropertiesService.getUserProperties().getProperty(SETTINGS_KEY);
  return raw ? JSON.parse(raw) : null;
}

function saveSettings(json) {
  if (typeof json !== 'string') throw new Error('settings must be a JSON string');
  if (json.length > MAX_SETTINGS_BYTES) throw new Error('Settings are too large (is the personal dictionary huge?)');
  JSON.parse(json); // validate before storing
  PropertiesService.getUserProperties().setProperty(SETTINGS_KEY, json);
  return true;
}
