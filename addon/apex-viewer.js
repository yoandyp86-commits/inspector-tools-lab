/* global React ReactDOM Prism */
import {sfConn, apiVersion} from "./inspector.js";
import {PageHeader} from "./components/PageHeader.js";
import {UserInfoModel, copyToClipboard} from "./utils.js";
/* global initButton */

let h = React.createElement;

const MAX_SUGGESTIONS = 50;
const MAX_MATCHES = 10000;

const COMMON_DETAIL_FIELDS = "Id, Name, NamespacePrefix, ApiVersion, Status, IsValid, LengthWithoutComments, Body,"
  + " CreatedBy.Name, CreatedDate, LastModifiedBy.Name, LastModifiedDate";

const TYPES = {
  ApexClass: {
    label: "Apex Class",
    singular: "class",
    plural: "classes",
    extension: ".cls",
    setupPath: "ApexClasses",
    listSoql: "SELECT Id, Name, NamespacePrefix, LengthWithoutComments FROM ApexClass ORDER BY Name",
    detailSoql: (id) => "SELECT " + COMMON_DETAIL_FIELDS + " FROM ApexClass WHERE Id = '" + id + "'",
  },
  ApexTrigger: {
    label: "Apex Trigger",
    singular: "trigger",
    plural: "triggers",
    extension: ".trigger",
    setupPath: "ApexTriggers",
    listSoql: "SELECT Id, Name, NamespacePrefix, LengthWithoutComments, TableEnumOrId FROM ApexTrigger ORDER BY Name",
    detailSoql: (id) => "SELECT " + COMMON_DETAIL_FIELDS + ", TableEnumOrId,"
      + " UsageBeforeInsert, UsageAfterInsert, UsageBeforeUpdate, UsageAfterUpdate,"
      + " UsageBeforeDelete, UsageAfterDelete, UsageAfterUndelete"
      + " FROM ApexTrigger WHERE Id = '" + id + "'",
  },
};

const TRIGGER_EVENTS = [
  ["UsageBeforeInsert", "before insert"],
  ["UsageAfterInsert", "after insert"],
  ["UsageBeforeUpdate", "before update"],
  ["UsageAfterUpdate", "after update"],
  ["UsageBeforeDelete", "before delete"],
  ["UsageAfterDelete", "after delete"],
  ["UsageAfterUndelete", "after undelete"],
];

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleString();
}

function formatNumber(n) {
  return Number(n).toLocaleString();
}

// ----- Search in code helpers -----

const SEARCH_MAX_LINE = 220;       // longer lines are cut around the first match
const SEARCH_LINES_PER_FILE = 50;  // lines shown per file before "show more"
const SEARCH_FILES_PAGE = 200;     // files rendered before "show more files"
const SEARCH_MAX_RANGES_PER_LINE = 200;

const SEARCH_SOURCES = [
  {type: "ApexClass", soql: "SELECT Id, Name, NamespacePrefix, LengthWithoutComments, Body FROM ApexClass ORDER BY Name", countSoql: "SELECT COUNT() FROM ApexClass"},
  {type: "ApexTrigger", soql: "SELECT Id, Name, NamespacePrefix, LengthWithoutComments, TableEnumOrId, Body FROM ApexTrigger ORDER BY Name", countSoql: "SELECT COUNT() FROM ApexTrigger"},
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds the global RegExp used by "Search in code". Throws on an invalid user regex. */
function buildSearchRegex(query, opts) {
  const src = opts.regex ? query : escapeRegex(query);
  const flags = "g" + (opts.matchCase ? "" : "i");
  if (!opts.wholeWord) return new RegExp(src, flags);
  try {
    // Identifier boundaries, valid also when the fragment starts/ends with a non-word char
    return new RegExp("(?<![A-Za-z0-9_])(?:" + src + ")(?![A-Za-z0-9_])", flags);
  } catch (e) {
    if (opts.regex) new RegExp(src, flags); // surface the user's own regex error first
    return new RegExp("\\b(?:" + src + ")\\b", flags); // engines without lookbehind
  }
}

/** Replaces Apex comments with spaces (keeps line breaks and offsets). String literals are respected. */
function maskComments(code) {
  const out = code.split("");
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === "'") {
      i++;
      while (i < n && code[i] !== "'" && code[i] !== "\n") {
        if (code[i] === "\\") i++;
        i++;
      }
      i++;
    } else if (c === "/" && d === "/") {
      while (i < n && code[i] !== "\n") { out[i] = " "; i++; }
    } else if (c === "/" && d === "*") {
      out[i] = " "; out[i + 1] = " "; i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        if (code[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) { out[i] = " "; out[i + 1] = " "; i += 2; }
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Searches each file line by line. Returns [{file, hits: [{line, text, ranges}], count}] sorted by count desc. */
function searchFiles(files, re, ignoreComments) {
  const results = [];
  for (const file of files) {
    let lines = file.lines;
    if (ignoreComments) {
      if (!file.maskedLines) file.maskedLines = maskComments(file.code).split("\n");
      lines = file.maskedLines;
    }
    const hits = [];
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      re.lastIndex = 0;
      const ranges = [];
      let m;
      while ((m = re.exec(line)) !== null) {
        if (m[0] === "") { re.lastIndex++; continue; }
        ranges.push([m.index, m.index + m[0].length]);
        if (ranges.length >= SEARCH_MAX_RANGES_PER_LINE) break;
      }
      if (ranges.length) {
        hits.push({line: i + 1, text: file.lines[i], ranges});
        count += ranges.length;
      }
    }
    if (hits.length) results.push({file, hits, count});
  }
  results.sort((a, b) => b.count - a.count || a.file.fullNameLower.localeCompare(b.file.fullNameLower));
  return results;
}

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
}

/**
 * Flattens the Prism token tree into leaf segments. Each segment keeps the
 * chain of token classes it lives in, so nested tokens (e.g. keywords inside
 * inline SOQL) can be re-rendered as nested spans.
 */
function flattenTokens(tokens, path, out) {
  for (const t of tokens) {
    if (typeof t === "string") {
      if (t) out.push({text: t, path});
      continue;
    }
    const aliases = t.alias ? [].concat(t.alias) : [];
    const cls = ["token", t.type].concat(aliases).join(" ");
    const nextPath = path.concat(cls);
    if (typeof t.content === "string") {
      if (t.content) out.push({text: t.content, path: nextPath});
    } else {
      flattenTokens(Array.isArray(t.content) ? t.content : [t.content], nextPath, out);
    }
  }
  return out;
}

function tokenizeApex(code) {
  if (window.Prism && Prism.tokenize && Prism.languages && Prism.languages.apex) {
    try {
      return flattenTokens(Prism.tokenize(code, Prism.languages.apex), [], []);
    } catch (e) {
      console.error("Prism tokenize failed", e);
    }
  }
  return [{text: code, path: []}];
}

class Model {
  constructor(sfHost) {
    this.reactCallback = null;
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.title = "Apex Code Viewer";
    this.errorMessages = [];

    this.type = "ApexClass";
    this.lists = {ApexClass: null, ApexTrigger: null};
    this.listLoading = {ApexClass: false, ApexTrigger: false};

    this.selected = null;        // detail of the selected record
    this.loadingDetail = false;
    this.detailRequestId = 0;

    this.segments = [];          // tokenized code
    this.code = "";              // normalized code (\n line endings)
    this.lineCount = 0;
    this.baseHtml = "";          // highlighted HTML without search marks

    this.findQuery = "";
    this.findMatchCase = false;
    this.matches = [];
    this.currentMatch = -1;
    this.matchesTruncated = false;
    this.scrollToCurrent = false;

    // ----- Search in code -----
    this.mode = "view";            // "view" | "search"
    this.cameFromSearch = false;
    this.search = {
      input: "",
      matchCase: false,
      wholeWord: false,
      regex: false,
      ignoreComments: false,
      classes: true,
      triggers: true,
      managed: false,
    };
    this.corpus = null;            // all classes/triggers with their code, cached while the tab is open
    this.corpusPromise = null;
    this.corpusProgress = {loaded: 0, total: 0};
    this.corpusLoadedAt = null;
    this.searchChain = [];         // [{query, results, analyzed, skipped, ms}] — last step is shown
    this.searchError = "";
    this.searching = false;
    this.resultFilter = "";
    this.collapsed = {};
    this.expandedFiles = {};
    this.fileLimit = SEARCH_FILES_PAGE;
    this.searchScrollTop = 0;
    this.restoreSearchScroll = false;

    this.userInfoModel = new UserInfoModel((promise) => {
      this.spinnerCount++;
      promise
        .then(() => { this.spinnerCount--; this.didUpdate(); })
        .catch(err => {
          console.error(err);
          this.errorMessages.push("Error retrieving user info: " + err.message);
          this.spinnerCount--;
          this.didUpdate();
        })
        .catch(err => console.log("error handling failed", err));
    });

    this.loadList(this.type);
  }

  didUpdate(cb) {
    if (this.reactCallback) { this.reactCallback(cb); }
  }

  async queryAll(soql) {
    let url = "/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql);
    const out = [];
    while (url) {
      const res = await sfConn.rest(url);
      out.push(...(res.records || []));
      url = res.nextRecordsUrl || null;
    }
    return out;
  }

  // ----- List / autocomplete -----

  loadList(type) {
    if (this.lists[type] || this.listLoading[type]) return;
    this.listLoading[type] = true;
    this.spinnerCount++;
    this.didUpdate();
    this.queryAll(TYPES[type].listSoql)
      .then(records => {
        this.lists[type] = records.map(r => {
          const fullName = r.NamespacePrefix ? r.NamespacePrefix + "__" + r.Name : r.Name;
          return {
            id: r.Id,
            name: r.Name,
            namespace: r.NamespacePrefix || "",
            fullName,
            fullNameLower: fullName.toLowerCase(),
            hidden: r.LengthWithoutComments === -1,
            object: r.TableEnumOrId || "",
          };
        });
      })
      .catch(err => {
        console.error(err);
        this.errorMessages.push("Error loading " + TYPES[type].plural + ": " + err.message);
      })
      .finally(() => {
        this.listLoading[type] = false;
        this.spinnerCount--;
        this.didUpdate();
      });
  }

  setType(type) {
    if (type === this.type) return;
    this.type = type;
    this.errorMessages = [];
    this.clearSelection();
    this.loadList(type);
    this.didUpdate();
  }

  suggestions(input) {
    const list = this.lists[this.type] || [];
    const q = (input || "").trim().toLowerCase();
    if (!q) {
      return {items: list.slice(0, MAX_SUGGESTIONS), total: list.length};
    }
    const starts = [];
    const contains = [];
    for (const item of list) {
      const idx = item.fullNameLower.indexOf(q);
      if (idx === -1) continue;
      if (idx === 0 || item.name.toLowerCase().startsWith(q)) starts.push(item);
      else contains.push(item);
    }
    const all = starts.concat(contains);
    return {items: all.slice(0, MAX_SUGGESTIONS), total: all.length};
  }

  // ----- Detail -----

  clearSelection() {
    this.detailRequestId++;
    this.selected = null;
    this.loadingDetail = false;
    this.segments = [];
    this.code = "";
    this.lineCount = 0;
    this.baseHtml = "";
    this.matches = [];
    this.currentMatch = -1;
    this.matchesTruncated = false;
  }

  selectRecord(item) {
    const type = this.type;
    this.clearSelection();
    this.errorMessages = [];
    this.loadingDetail = true;
    const requestId = this.detailRequestId;
    this.didUpdate();

    const soql = TYPES[type].detailSoql(item.id);
    this.spinnerCount++;
    sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql))
      .then(res => {
        if (requestId !== this.detailRequestId) return;
        const r = (res.records || [])[0];
        if (!r) {
          this.errorMessages.push("The selected " + TYPES[type].singular + " was not found. It may have been deleted.");
          return;
        }
        this.setSelected(type, item, r);
      })
      .catch(err => {
        if (requestId !== this.detailRequestId) return;
        console.error(err);
        this.errorMessages.push("Error loading " + TYPES[type].singular + ": " + err.message);
      })
      .finally(() => {
        this.spinnerCount--;
        if (requestId === this.detailRequestId) this.loadingDetail = false;
        this.didUpdate();
      });
  }

  setSelected(type, item, r) {
    const body = r.Body || "";
    const hidden = r.LengthWithoutComments === -1 || body.trim() === "(hidden)";
    const code = body.replace(/\r\n?/g, "\n");
    let lineCount = code ? code.split("\n").length : 0;
    // A trailing newline is not rendered as an extra line inside <pre>
    if (code.endsWith("\n")) lineCount--;

    const sel = {
      type,
      id: r.Id,
      name: r.Name,
      namespace: r.NamespacePrefix || "",
      fullName: item.fullName,
      apiVersion: r.ApiVersion,
      status: r.Status,
      isValid: r.IsValid,
      length: r.LengthWithoutComments,
      body,
      hidden,
      createdBy: r.CreatedBy ? r.CreatedBy.Name : "",
      createdDate: r.CreatedDate,
      lastModifiedBy: r.LastModifiedBy ? r.LastModifiedBy.Name : "",
      lastModifiedDate: r.LastModifiedDate,
      lineCount: hidden ? 0 : lineCount,
      isTest: !hidden && type === "ApexClass" && /@istest\b/i.test(body),
      object: r.TableEnumOrId || "",
      events: type === "ApexTrigger" ? TRIGGER_EVENTS.filter(([f]) => r[f]).map(([, label]) => label) : [],
    };
    this.selected = sel;
    if (!hidden) {
      this.code = code;
      this.lineCount = lineCount;
      this.segments = tokenizeApex(code);
      this.baseHtml = this.renderSegments([], -1);
    }
    this.computeMatches();
    if (this.targetLine) {
      this.selectMatchOnLine(this.targetLine);
      this.targetLine = 0;
    }
  }

  /** Makes the first match located on the given line the current one (deep link &line=). */
  selectMatchOnLine(line) {
    if (!this.matches.length || !this.code) return;
    const lines = this.code.split("\n");
    let start = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
    const end = start + (lines[line - 1] || "").length;
    const idx = this.matches.findIndex(m => m.start >= start && m.start <= end);
    if (idx !== -1) {
      this.currentMatch = idx;
      this.scrollToCurrent = true;
    }
  }

  // ----- Find in code -----

  setFindQuery(q) {
    this.findQuery = q;
    this.computeMatches();
    this.didUpdate();
  }

  toggleMatchCase() {
    this.findMatchCase = !this.findMatchCase;
    this.computeMatches();
    this.didUpdate();
  }

  computeMatches() {
    this.matches = [];
    this.currentMatch = -1;
    this.matchesTruncated = false;
    const q = this.findQuery;
    if (!q || !this.code) return;
    const hay = this.findMatchCase ? this.code : this.code.toLowerCase();
    const needle = this.findMatchCase ? q : q.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      if (this.matches.length >= MAX_MATCHES) { this.matchesTruncated = true; break; }
      this.matches.push({start: idx, end: idx + needle.length});
      idx = hay.indexOf(needle, idx + needle.length);
    }
    if (this.matches.length > 0) {
      this.currentMatch = 0;
      this.scrollToCurrent = true;
    }
  }

  gotoMatch(delta) {
    const n = this.matches.length;
    if (n === 0) return;
    this.currentMatch = (this.currentMatch + delta + n) % n;
    this.scrollToCurrent = true;
    this.didUpdate();
  }

  codeHtml() {
    if (this.matches.length === 0) return this.baseHtml;
    return this.renderSegments(this.matches, this.currentMatch);
  }

  renderSegments(matches, current) {
    let html = "";
    let pos = 0;
    let mi = 0;
    for (const seg of this.segments) {
      const segStart = pos;
      const segEnd = pos + seg.text.length;
      html += seg.path.map(c => "<span class=\"" + c + "\">").join("");
      let cursor = segStart;
      while (cursor < segEnd) {
        while (mi < matches.length && matches[mi].end <= cursor) mi++;
        const m = matches[mi];
        if (!m || m.start >= segEnd) {
          html += escapeHtml(seg.text.slice(cursor - segStart));
          cursor = segEnd;
          break;
        }
        if (m.start > cursor) {
          html += escapeHtml(seg.text.slice(cursor - segStart, m.start - segStart));
          cursor = m.start;
        }
        const end = Math.min(m.end, segEnd);
        const isCurrent = mi === current;
        const idAttr = isCurrent && cursor === m.start ? " id=\"av-current-match\"" : "";
        html += "<mark class=\"av-match" + (isCurrent ? " av-match-current" : "") + "\"" + idAttr + ">"
          + escapeHtml(seg.text.slice(cursor - segStart, end - segStart)) + "</mark>";
        cursor = end;
      }
      html += "</span>".repeat(seg.path.length);
      pos = segEnd;
    }
    return html;
  }

  // ----- Search in code -----

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "search") {
      this.restoreSearchScroll = true;
    } else {
      this.cameFromSearch = false;
    }
    this.didUpdate();
  }

  setSearchOption(key, value) {
    this.search[key] = value;
    this.didUpdate();
  }

  async loadCorpus(force) {
    if (this.corpus && !force) return this.corpus;
    if (this.corpusPromise) return this.corpusPromise;
    this.corpusPromise = (async () => {
      this.spinnerCount++;
      this.corpusProgress = {loaded: 0, total: 0};
      this.didUpdate();
      try {
        const base = "/services/data/v" + apiVersion + "/query/?q=";
        const counts = await Promise.all(SEARCH_SOURCES.map(src => sfConn.rest(base + encodeURIComponent(src.countSoql))));
        this.corpusProgress.total = counts.reduce((sum, r) => sum + (r.totalSize || 0), 0);
        this.didUpdate();
        const corpus = [];
        for (const src of SEARCH_SOURCES) {
          let url = base + encodeURIComponent(src.soql);
          while (url) {
            const res = await sfConn.rest(url);
            for (const r of res.records || []) {
              const body = r.Body || "";
              const code = body.replace(/\r\n?/g, "\n");
              const fullName = r.NamespacePrefix ? r.NamespacePrefix + "__" + r.Name : r.Name;
              corpus.push({
                type: src.type,
                id: r.Id,
                name: r.Name,
                namespace: r.NamespacePrefix || "",
                fullName,
                fullNameLower: fullName.toLowerCase(),
                object: r.TableEnumOrId || "",
                hidden: r.LengthWithoutComments === -1 || body.trim() === "(hidden)",
                code,
                lines: code.split("\n"),
                maskedLines: null,
              });
            }
            this.corpusProgress.loaded = corpus.length;
            this.didUpdate();
            url = res.nextRecordsUrl || null;
          }
        }
        this.corpus = corpus;
        this.corpusLoadedAt = new Date();
        return corpus;
      } finally {
        this.spinnerCount--;
        this.corpusPromise = null;
        this.didUpdate();
      }
    })();
    return this.corpusPromise;
  }

  async reloadCorpus() {
    this.searchError = "";
    try {
      await this.loadCorpus(true);
      if (this.searchChain.length) {
        // Re-run the whole chain against the fresh code
        const chain = this.searchChain.map(st => st.query);
        const opts = this.searchChain.map(st => st.opts);
        this.searchChain = [];
        for (let i = 0; i < chain.length; i++) {
          if (!this.executeStep(chain[i], opts[i], i > 0)) break;
        }
        this.didUpdate();
      }
    } catch (err) {
      console.error(err);
      this.searchError = "Error loading Apex code: " + err.message;
      this.didUpdate();
    }
  }

  async runSearch(refine) {
    const q = this.search.input;
    this.searchError = "";
    if (q.trim().length < 2) {
      this.searchError = "Type at least 2 characters.";
      this.didUpdate();
      return;
    }
    if (!refine && !this.search.classes && !this.search.triggers) {
      this.searchError = "Select at least one type: Classes or Triggers.";
      this.didUpdate();
      return;
    }
    try {
      buildSearchRegex(q, this.search);
    } catch (e) {
      this.searchError = /^Invalid regular expression/.test(e.message) ? e.message : "Invalid regular expression: " + e.message;
      this.didUpdate();
      return;
    }
    this.searching = true;
    this.didUpdate();
    try {
      await this.loadCorpus(false);
      this.executeStep(q, Object.assign({}, this.search), refine && this.searchChain.length > 0);
    } catch (err) {
      console.error(err);
      this.searchError = "Error loading Apex code: " + err.message;
    } finally {
      this.searching = false;
      this.didUpdate();
    }
  }

  /** Runs one search step synchronously on the cached corpus. Returns false on error. */
  executeStep(query, opts, refine) {
    let re;
    try {
      re = buildSearchRegex(query, opts);
    } catch (e) {
      this.searchError = /^Invalid regular expression/.test(e.message) ? e.message : "Invalid regular expression: " + e.message;
      return false;
    }
    const t0 = performance.now();
    let scope;
    if (refine) {
      const ids = new Set(this.searchChain[this.searchChain.length - 1].results.map(r => r.file.id));
      scope = this.corpus.filter(f => ids.has(f.id));
    } else {
      scope = this.corpus.filter(f =>
        (f.type === "ApexClass" ? opts.classes : opts.triggers) && (opts.managed || !f.namespace));
    }
    const visible = scope.filter(f => !f.hidden);
    const results = searchFiles(visible, re, opts.ignoreComments);
    const step = {
      query,
      opts,
      results,
      analyzed: visible.length,
      skipped: scope.length - visible.length,
      ms: Math.round(performance.now() - t0),
    };
    this.searchChain = refine ? this.searchChain.concat([step]) : [step];
    this.collapsed = {};
    this.expandedFiles = {};
    this.fileLimit = SEARCH_FILES_PAGE;
    this.searchScrollTop = 0;
    this.restoreSearchScroll = true;
    return true;
  }

  popSearchStep() {
    if (!this.searchChain.length) return;
    this.searchChain = this.searchChain.slice(0, -1);
    this.collapsed = {};
    this.expandedFiles = {};
    this.fileLimit = SEARCH_FILES_PAGE;
    this.searchScrollTop = 0;
    this.restoreSearchScroll = true;
    this.didUpdate();
  }

  currentStep() {
    return this.searchChain.length ? this.searchChain[this.searchChain.length - 1] : null;
  }

  filteredResults() {
    const step = this.currentStep();
    if (!step) return [];
    const f = this.resultFilter.trim().toLowerCase();
    return f ? step.results.filter(r => r.file.fullNameLower.includes(f)) : step.results;
  }

  setResultFilter(v) {
    this.resultFilter = v;
    this.fileLimit = SEARCH_FILES_PAGE;
    this.didUpdate();
  }

  toggleCollapsed(id) {
    this.collapsed[id] = !this.collapsed[id];
    this.didUpdate();
  }

  setAllCollapsed(value) {
    const next = {};
    if (value) for (const r of this.filteredResults()) next[r.file.id] = true;
    this.collapsed = next;
    this.didUpdate();
  }

  expandFile(id) {
    this.expandedFiles[id] = true;
    this.didUpdate();
  }

  showMoreFiles() {
    this.fileLimit += SEARCH_FILES_PAGE;
    this.didUpdate();
  }

  resultsCsv() {
    const rows = [["Type", "Name", "Line", "Code"]];
    for (const r of this.filteredResults()) {
      for (const hit of r.hits) {
        rows.push([TYPES[r.file.type].label, r.file.fullName, hit.line, hit.text.trim()]);
      }
    }
    return rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  }

  fileSetupUrl(file) {
    return this.sfLink + "/lightning/setup/" + TYPES[file.type].setupPath + "/page?address=%2F" + file.id;
  }

  /** Opens a search hit in View mode, scrolled to the line, with the matched text in Find. */
  openFromSearch(file, hit, scrollTop) {
    const r = hit.ranges[0];
    const step = this.currentStep();
    this.searchScrollTop = scrollTop || 0;
    this.mode = "view";
    this.cameFromSearch = true;
    this.findQuery = hit.text.slice(r[0], r[1]);
    this.findMatchCase = !!(step && step.opts.matchCase);
    this.targetLine = hit.line;
    if (this.type !== file.type) {
      this.type = file.type;
      this.loadList(file.type);
    }
    this.selectRecord({id: file.id, fullName: file.fullName});
  }

  backToResults() {
    this.mode = "search";
    this.restoreSearchScroll = true;
    this.didUpdate();
  }

  // ----- Actions -----

  copyCode() {
    if (this.selected && !this.selected.hidden) copyToClipboard(this.selected.body);
  }

  downloadCode() {
    const sel = this.selected;
    if (!sel || sel.hidden) return;
    const blob = new Blob([sel.body], {type: "text/plain;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sel.name + TYPES[sel.type].extension;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  setupUrl() {
    const sel = this.selected;
    if (!sel) return "#";
    return this.sfLink + "/lightning/setup/" + TYPES[sel.type].setupPath + "/page?address=%2F" + sel.id;
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.state = {input: props.vm.initialName || "", open: false, activeIndex: 0, copied: false, metaOpen: false, csvCopied: false};
    // Callback refs (React 15 has no createRef)
    this.inputEl = null;
    this.findEl = null;
    this.dropdownEl = null;
    this.searchEl = null;
    this.bodyEl = null;
    this.onInput = this.onInput.bind(this);
    this.onInputKeyDown = this.onInputKeyDown.bind(this);
    this.onFocus = this.onFocus.bind(this);
    this.onBlur = this.onBlur.bind(this);
    this.onTypeChange = this.onTypeChange.bind(this);
    this.onFindInput = this.onFindInput.bind(this);
    this.onFindKeyDown = this.onFindKeyDown.bind(this);
    this.onCopy = this.onCopy.bind(this);
    this.onGlobalKeyDown = this.onGlobalKeyDown.bind(this);
  }

  componentDidMount() {
    document.addEventListener("keydown", this.onGlobalKeyDown);
  }

  componentWillUnmount() {
    document.removeEventListener("keydown", this.onGlobalKeyDown);
    clearTimeout(this.copiedTimer);
    clearTimeout(this.csvTimer);
  }

  componentDidUpdate() {
    const model = this.props.vm;
    if (model.mode === "search" && model.restoreSearchScroll && this.bodyEl) {
      model.restoreSearchScroll = false;
      this.bodyEl.scrollTop = model.searchScrollTop;
    }
    if (model.scrollToCurrent) {
      model.scrollToCurrent = false;
      const el = document.getElementById("av-current-match");
      if (el) el.scrollIntoView({block: "center", inline: "nearest"});
    }
    if (this.state.open && this.dropdownEl) {
      const active = this.dropdownEl.querySelector(".av-active");
      if (active) active.scrollIntoView({block: "nearest"});
    }
  }

  onGlobalKeyDown(e) {
    const model = this.props.vm;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      model.setMode("search");
      setTimeout(() => { if (this.searchEl) { this.searchEl.focus(); this.searchEl.select(); } }, 0);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && model.mode === "view" && model.selected && !model.selected.hidden) {
      e.preventDefault();
      if (this.findEl) {
        this.findEl.focus();
        this.findEl.select();
      }
    }
  }

  onInput(e) { this.setState({input: e.target.value, open: true, activeIndex: 0}); }
  onFocus() { this.setState({open: true}); }
  onBlur() { this.setState({open: false}); }

  onInputKeyDown(e) {
    const {items} = this.props.vm.suggestions(this.state.input);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!this.state.open) { this.setState({open: true}); return; }
      this.setState({activeIndex: Math.min(this.state.activeIndex + 1, items.length - 1)});
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.setState({activeIndex: Math.max(this.state.activeIndex - 1, 0)});
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[this.state.activeIndex];
      if (this.state.open && item) this.select(item);
    } else if (e.key === "Escape") {
      this.setState({open: false});
    }
  }

  select(item) {
    this.setState({input: item.fullName, open: false, activeIndex: 0});
    if (this.inputEl) this.inputEl.blur();
    this.props.vm.selectRecord(item);
  }

  onTypeChange(e) {
    this.setState({input: "", open: false, activeIndex: 0});
    this.props.vm.setType(e.target.value);
  }

  onFindInput(e) { this.props.vm.setFindQuery(e.target.value); }

  onFindKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.props.vm.gotoMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      this.props.vm.setFindQuery("");
    }
  }

  onCopy() {
    this.props.vm.copyCode();
    this.setState({copied: true});
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => this.setState({copied: false}), 1500);
  }

  // ----- Search in code (UI) -----

  openResult(file, hit) {
    this.setState({input: file.fullName, open: false});
    this.props.vm.openFromSearch(file, hit, this.bodyEl ? this.bodyEl.scrollTop : 0);
  }

  onCopyCsv() {
    copyToClipboard(this.props.vm.resultsCsv());
    this.setState({csvCopied: true});
    clearTimeout(this.csvTimer);
    this.csvTimer = setTimeout(() => this.setState({csvCopied: false}), 1500);
  }

  renderModeBar() {
    const model = this.props.vm;
    const btn = (mode, label, title) => h("button", {
      className: "slds-button " + (model.mode === mode ? "slds-button_brand" : "slds-button_neutral"),
      "aria-pressed": model.mode === mode ? "true" : "false",
      title,
      onClick: () => model.setMode(mode),
    }, label);
    return h("div", {className: "av-mode-bar"},
      h("div", {className: "slds-button-group", role: "group"},
        btn("view", "View", "View the source code of one class or trigger"),
        btn("search", "Search in code", "Find which classes/triggers contain a code fragment (Ctrl+Shift+H)")
      ),
      model.mode === "view" && model.cameFromSearch && model.searchChain.length > 0 && h("button", {
        className: "slds-button slds-button_neutral",
        title: "Back to the search results",
        onClick: () => model.backToResults(),
      }, "\u2190 Back to results")
    );
  }

  renderSearchBar() {
    const model = this.props.vm;
    const s = model.search;
    const busy = model.searching || !!model.corpusPromise;
    const opt = (key, label, title) => h("label", {className: "av-case-toggle", title},
      h("input", {
        type: "checkbox",
        checked: s[key],
        onChange: e => model.setSearchOption(key, e.target.checked),
        style: {marginRight: ".25rem", verticalAlign: "middle"},
      }),
      label);
    return h("div", {},
      h("div", {className: "slds-grid slds-grid_vertical-align-end", style: {gap: ".5rem"}},
        h("div", {className: "slds-form-element av-search-wrapper"},
          h("label", {className: "slds-form-element__label"}, "Code fragment"),
          h("div", {className: "slds-form-element__control slds-input-has-icon slds-input-has-icon_left"},
            h("svg", {className: "slds-icon slds-input__icon slds-input__icon_left slds-icon-text-default", viewBox: "0 0 520 520"},
              h("use", {xlinkHref: "symbols.svg#search"})),
            h("input", {
              ref: el => { this.searchEl = el; },
              type: "search",
              className: "slds-input av-mono",
              placeholder: "e.g. Case_SLA_At_Risk, GroupMember, OwnerId…",
              value: s.input,
              autoFocus: true,
              autoComplete: "off",
              spellCheck: false,
              onChange: e => model.setSearchOption("input", e.target.value),
              onKeyDown: e => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  model.runSearch(e.shiftKey && model.searchChain.length > 0);
                }
              },
            })
          )
        ),
        h("button", {
          className: "slds-button slds-button_brand",
          disabled: busy,
          title: "New search in all selected classes/triggers (Enter)",
          onClick: () => model.runSearch(false),
        }, "Search"),
        h("button", {
          className: "slds-button slds-button_neutral",
          disabled: busy || model.searchChain.length === 0,
          title: "Search this fragment only inside the files of the current results (Shift+Enter)",
          onClick: () => model.runSearch(true),
        }, "Refine")
      ),
      h("div", {className: "av-search-options"},
        opt("matchCase", "Match case", "Case-sensitive search"),
        opt("wholeWord", "Whole word", "Match whole identifiers only"),
        opt("regex", "Regex", "Treat the fragment as a JavaScript regular expression"),
        opt("ignoreComments", "Ignore comments", "Skip matches inside // and /* */ comments"),
        h("span", {className: "av-sep"}),
        opt("classes", "Classes", "Search in Apex classes"),
        opt("triggers", "Triggers", "Search in Apex triggers"),
        opt("managed", "Include managed packages", "Also search classes from managed packages (their code is usually hidden)"),
        h("span", {className: "av-search-cache"},
          model.corpus && h("span", {className: "slds-m-right_x-small"},
            formatNumber(model.corpus.length) + " files cached at " + model.corpusLoadedAt.toLocaleTimeString()),
          h("button", {
            className: "slds-button slds-button_neutral",
            disabled: busy,
            title: "Download the code again (e.g. after a deployment)",
            onClick: () => model.reloadCorpus(),
          }, "Reload code"))
      )
    );
  }

  renderSnippet(hit) {
    const text = hit.text;
    const lead = text.match(/^\s*/)[0].length;
    let start = lead;
    let end = text.length;
    if (end - start > SEARCH_MAX_LINE) {
      start = Math.max(lead, hit.ranges[0][0] - 60);
      end = Math.min(text.length, start + SEARCH_MAX_LINE);
    }
    const parts = [];
    if (start > lead) parts.push("\u2026");
    let pos = start;
    hit.ranges.forEach((r, i) => {
      const a = Math.max(r[0], start);
      const b = Math.min(r[1], end);
      if (b <= a || a < pos) return;
      if (a > pos) parts.push(text.slice(pos, a));
      parts.push(h("mark", {key: "m" + i, className: "av-match"}, text.slice(a, b)));
      pos = b;
    });
    if (pos < end) parts.push(text.slice(pos, end));
    if (end < text.length) parts.push("\u2026");
    return parts;
  }

  renderResultFile(r) {
    const model = this.props.vm;
    const file = r.file;
    const collapsed = !!model.collapsed[file.id];
    const showAll = !!model.expandedFiles[file.id];
    const hits = showAll ? r.hits : r.hits.slice(0, SEARCH_LINES_PER_FILE);
    return h("div", {key: file.id, className: "av-res-file"},
      h("div", {className: "av-res-file-header", onClick: () => model.toggleCollapsed(file.id)},
        h("span", {className: "av-res-toggle"}, collapsed ? "\u25B8" : "\u25BE"),
        h("span", {className: "slds-badge " + (file.type === "ApexClass" ? "av-badge-info" : "av-badge-test")},
          file.type === "ApexClass" ? "Class" : "Trigger"),
        h("code", {className: "av-res-name"}, file.fullName),
        file.object && h("span", {className: "av-dropdown-sub"}, "on " + file.object),
        h("span", {className: "av-res-count"}, formatNumber(r.count) + (r.count === 1 ? " match" : " matches")),
        h("a", {
          className: "av-res-setup",
          href: model.fileSetupUrl(file),
          target: "_blank",
          rel: "noopener noreferrer",
          onClick: e => e.stopPropagation(),
        }, "Open in Setup")
      ),
      !collapsed && h("div", {className: "av-res-lines"},
        hits.map(hit => h("div", {
          key: hit.line,
          className: "av-res-line",
          title: "Open " + file.fullName + " at line " + hit.line,
          onClick: () => this.openResult(file, hit),
        },
        h("span", {className: "av-res-lineno"}, hit.line),
        h("span", {className: "av-res-code"}, this.renderSnippet(hit))
        )),
        !showAll && r.hits.length > SEARCH_LINES_PER_FILE && h("button", {
          className: "slds-button av-res-more",
          onClick: () => model.expandFile(file.id),
        }, "Show " + formatNumber(r.hits.length - SEARCH_LINES_PER_FILE) + " more lines")
      )
    );
  }

  renderSearchResults() {
    const model = this.props.vm;
    const out = [];
    if (model.searchError) {
      out.push(h("div", {key: "err", className: "slds-notify slds-notify_alert slds-theme_error slds-m-bottom_small", role: "alert"}, model.searchError));
    }
    if (model.corpusPromise) {
      const {loaded, total} = model.corpusProgress;
      const pct = total ? Math.min(100, Math.round(loaded * 100 / total)) : 0;
      out.push(h("div", {key: "load", className: "av-empty"},
        h("div", {}, "Loading Apex code… " + formatNumber(loaded) + (total ? " / " + formatNumber(total) : "") + " files"),
        h("div", {className: "av-progress"}, h("div", {className: "av-progress-bar", style: {width: pct + "%"}}))));
      return out;
    }
    const step = model.currentStep();
    if (!step) {
      out.push(h("div", {key: "empty", className: "av-empty"},
        h("div", {}, "Find which Apex classes and triggers contain a code fragment: a template name, an object, a field, a method…"),
        h("div", {className: "slds-m-top_x-small"}, "Tip: search a first term, then type a second one and press Refine to look for it only inside those files.")));
      return out;
    }
    const results = model.filteredResults();
    const totalMatches = step.results.reduce((sum, r) => sum + r.count, 0);
    out.push(h("div", {key: "chain", className: "av-chain"},
      model.searchChain.map((st, i) => {
        const last = i === model.searchChain.length - 1;
        return h("span", {key: i, className: "av-chip" + (last ? " av-chip-last" : "")},
          i > 0 && h("span", {className: "av-chip-sep"}, "\u203A"),
          h("code", {}, st.query),
          last && h("button", {
            className: "av-chip-remove",
            title: model.searchChain.length > 1 ? "Remove this step and go back" : "Clear the search",
            onClick: () => model.popSearchStep(),
          }, "\u00D7"));
      }),
      h("span", {className: "av-summary"},
        formatNumber(totalMatches) + (totalMatches === 1 ? " match" : " matches") + " in "
        + formatNumber(step.results.length) + (step.results.length === 1 ? " file" : " files")
        + " \u00B7 " + formatNumber(step.analyzed) + " analyzed"
        + (step.skipped ? " \u00B7 " + formatNumber(step.skipped) + " skipped (code hidden)" : "")
        + " \u00B7 " + step.ms + " ms")
    ));
    if (step.results.length === 0) {
      out.push(h("div", {key: "none", className: "av-empty"},
        "No match for \u00AB" + step.query + "\u00BB in " + formatNumber(step.analyzed) + " files analyzed."));
      return out;
    }
    out.push(h("div", {key: "tools", className: "av-res-toolbar"},
      h("input", {
        type: "search",
        className: "slds-input av-res-filter",
        placeholder: "Filter results by file name",
        value: model.resultFilter,
        onChange: e => model.setResultFilter(e.target.value),
      }),
      model.resultFilter && h("span", {className: "av-find-count"}, formatNumber(results.length) + " of " + formatNumber(step.results.length) + " files"),
      h("div", {className: "av-actions"},
        h("button", {className: "slds-button slds-button_neutral", onClick: () => model.setAllCollapsed(false)}, "Expand all"),
        h("button", {className: "slds-button slds-button_neutral", onClick: () => model.setAllCollapsed(true)}, "Collapse all"),
        h("button", {
          className: "slds-button slds-button_neutral",
          title: "Copy all result lines as CSV (Type, Name, Line, Code)",
          disabled: results.length === 0,
          onClick: () => this.onCopyCsv(),
        }, this.state.csvCopied ? "Copied" : "Copy CSV")
      )
    ));
    out.push(h("div", {key: "list", className: "av-res-list"},
      results.slice(0, model.fileLimit).map(r => this.renderResultFile(r)),
      results.length > model.fileLimit && h("button", {
        className: "slds-button slds-button_neutral av-res-more-files",
        onClick: () => model.showMoreFiles(),
      }, "Show more files (" + formatNumber(results.length - model.fileLimit) + " left)")
    ));
    return out;
  }

  renderHighlightedName(item, input) {
    const q = input.trim().toLowerCase();
    const idx = q ? item.fullNameLower.indexOf(q) : -1;
    if (idx === -1) return item.fullName;
    return [
      item.fullName.slice(0, idx),
      h("mark", {key: "m"}, item.fullName.slice(idx, idx + q.length)),
      item.fullName.slice(idx + q.length),
    ];
  }

  renderDropdown() {
    const model = this.props.vm;
    if (!this.state.open || !model.lists[model.type]) return null;
    const {items, total} = model.suggestions(this.state.input);
    const typeInfo = TYPES[model.type];
    return h("div", {className: "av-dropdown", ref: el => { this.dropdownEl = el; }},
      items.length === 0 && h("div", {className: "av-dropdown-footer"}, "No " + typeInfo.plural + " match your search."),
      items.map((item, idx) =>
        h("div", {
          key: item.id,
          className: "av-dropdown-item" + (idx === this.state.activeIndex ? " av-active" : ""),
          onMouseDown: (e) => { e.preventDefault(); this.select(item); },
          onMouseEnter: () => this.setState({activeIndex: idx}),
        },
        h("span", {className: "slds-truncate"}, this.renderHighlightedName(item, this.state.input)),
        h("span", {className: "av-dropdown-sub"},
          item.object && h("span", {className: "slds-m-right_x-small"}, "on " + item.object),
          item.hidden && h("span", {className: "slds-badge av-badge-hidden"}, "Code hidden")
        )
        )
      ),
      total > items.length && h("div", {className: "av-dropdown-footer"},
        "Showing " + items.length + " of " + formatNumber(total) + ". Keep typing to narrow down.")
    );
  }

  renderMeta(sel) {
    const typeInfo = TYPES[sel.type];
    const field = (label, value) => h("div", {key: label},
      h("div", {className: "av-meta-label"}, label),
      h("div", {className: "av-meta-value"}, value));
    const fields = [
      field("Type", typeInfo.label),
      field("Namespace", sel.namespace || "—"),
      field("API Version", sel.apiVersion != null ? String(sel.apiVersion) : "—"),
      field("Lines", sel.hidden ? "—" : formatNumber(sel.lineCount)),
      field("Size without comments", sel.hidden || sel.length == null ? "—" : formatNumber(sel.length) + " chars"),
      field("Created", (sel.createdBy || "—") + ", " + formatDate(sel.createdDate)),
      field("Last modified", (sel.lastModifiedBy || "—") + ", " + formatDate(sel.lastModifiedDate)),
    ];
    if (sel.type === "ApexTrigger") {
      fields.splice(1, 0, field("Object", sel.object || "—"));
      fields.push(field("Events", sel.events.length ? sel.events.join(", ") : "—"));
    }
    const statusClass = sel.status === "Active" ? "av-badge-ok" : (sel.status === "Deleted" ? "av-badge-error" : "av-badge-warn");
    const metaOpen = this.state.metaOpen;
    return h("div", {},
      h("div", {className: "av-meta-header slds-grid slds-grid_vertical-align-center slds-wrap" + (metaOpen ? "" : " av-meta-header-collapsed")},
        h("button", {
          className: "av-meta-toggle",
          "aria-expanded": metaOpen ? "true" : "false",
          title: metaOpen ? "Hide details" : "Show details",
          onClick: () => this.setState({metaOpen: !metaOpen}),
        }, metaOpen ? "\u25BE" : "\u25B8"),
        h("h2", {className: "slds-text-heading_small slds-m-right_small"}, h("code", {}, sel.fullName)),
        h("span", {className: "slds-badge " + statusClass}, sel.status || "Unknown"),
        h("span", {className: "slds-badge " + (sel.isValid ? "av-badge-ok" : "av-badge-error")}, sel.isValid ? "Valid" : "Invalid"),
        sel.isTest && h("span", {className: "slds-badge av-badge-test"}, "Test class"),
        sel.namespace && h("span", {className: "slds-badge av-badge-info"}, "Namespace " + sel.namespace),
        sel.hidden && h("span", {className: "slds-badge av-badge-hidden"}, "Code hidden")
      ),
      metaOpen && h("div", {className: "av-meta"}, fields)
    );
  }

  renderToolbar(sel) {
    const model = this.props.vm;
    const n = model.matches.length;
    let countText = "";
    if (model.findQuery) {
      countText = n === 0 ? "No results" : (model.currentMatch + 1) + " of " + formatNumber(n) + (model.matchesTruncated ? "+" : "");
    }
    return h("div", {className: "av-toolbar"},
      h("div", {className: "av-find"},
        h("div", {className: "slds-form-element__control slds-input-has-icon slds-input-has-icon_left", style: {flex: "1", maxWidth: "22rem"}},
          h("svg", {className: "slds-icon slds-input__icon slds-input__icon_left slds-icon-text-default", viewBox: "0 0 520 520"},
            h("use", {xlinkHref: "symbols.svg#search"})),
          h("input", {
            ref: el => { this.findEl = el; },
            type: "search",
            className: "slds-input",
            placeholder: "Find in code (Ctrl+F)",
            value: model.findQuery,
            disabled: sel.hidden,
            onChange: this.onFindInput,
            onKeyDown: this.onFindKeyDown,
          })
        ),
        h("span", {className: "av-find-count"}, countText),
        h("button", {
          className: "slds-button slds-button_neutral",
          disabled: n === 0,
          title: "Previous match (Shift+Enter)",
          onClick: () => model.gotoMatch(-1),
        }, "↑"),
        h("button", {
          className: "slds-button slds-button_neutral",
          disabled: n === 0,
          title: "Next match (Enter)",
          onClick: () => model.gotoMatch(1),
        }, "↓"),
        h("label", {className: "av-case-toggle slds-m-left_x-small"},
          h("input", {
            type: "checkbox",
            checked: model.findMatchCase,
            disabled: sel.hidden,
            onChange: () => model.toggleMatchCase(),
            style: {marginRight: ".25rem", verticalAlign: "middle"},
          }),
          "Match case")
      ),
      h("div", {className: "av-actions"},
        h("button", {
          className: "slds-button slds-button_neutral",
          disabled: sel.hidden,
          title: "Copy the source code to the clipboard",
          onClick: this.onCopy,
        }, this.state.copied ? "Copied" : "Copy code"),
        h("button", {
          className: "slds-button slds-button_neutral",
          disabled: sel.hidden,
          title: "Download as " + sel.name + TYPES[sel.type].extension,
          onClick: () => model.downloadCode(),
        }, "Download"),
        h("a", {
          className: "slds-button slds-button_neutral",
          href: model.setupUrl(),
          target: "_blank",
          rel: "noopener noreferrer",
          title: "Open this " + TYPES[sel.type].singular + " in Setup",
        }, "Open in Setup")
      )
    );
  }

  renderCode(sel) {
    const model = this.props.vm;
    if (sel.hidden) {
      return h("div", {className: "av-hidden-code"},
        "Code not visible: this " + TYPES[sel.type].singular + " belongs to the managed package "
        + (sel.namespace || "(unknown namespace)") + ", so Salesforce does not expose its source.");
    }
    const gutter = Array.from({length: Math.max(model.lineCount, 1)}, (_, i) => i + 1).join("\n");
    return h("div", {className: "av-code-scroll"},
      h("div", {className: "av-code-grid"},
        h("pre", {className: "av-gutter", "aria-hidden": "true"}, gutter),
        h("pre", {className: "av-code", dangerouslySetInnerHTML: {__html: model.codeHtml()}})
      )
    );
  }

  render() {
    const model = this.props.vm;
    document.title = model.title;
    const typeInfo = TYPES[model.type];
    const list = model.lists[model.type];
    const sel = model.selected;
    return h("div", {},
      h(PageHeader, {
        pageTitle: "Apex Code Viewer",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        ...model.userInfoModel.getProps()
      }),
      h("div", {className: "slds-m-top_xx-large sfir-page-container"},
        h("div", {className: "slds-card slds-m-around_medium", style: {flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0}},
          h("div", {className: "slds-card__header slds-p-horizontal_small slds-p-top_small"},
            this.renderModeBar(),
            model.mode === "search" && this.renderSearchBar(),
            model.mode === "view" && h("div", {className: "slds-grid slds-grid_vertical-align-end", style: {gap: ".5rem"}},
              h("div", {className: "slds-form-element av-type-select"},
                h("label", {className: "slds-form-element__label"}, "Type"),
                h("div", {className: "slds-form-element__control"},
                  h("div", {className: "slds-select_container"},
                    h("select", {className: "slds-select", value: model.type, onChange: this.onTypeChange},
                      Object.keys(TYPES).map(t => h("option", {key: t, value: t}, TYPES[t].label))
                    )
                  )
                )
              ),
              h("div", {className: "slds-form-element av-search-wrapper"},
                h("label", {className: "slds-form-element__label"}, typeInfo.label + " name"),
                h("div", {className: "slds-form-element__control slds-input-has-icon slds-input-has-icon_left"},
                  h("svg", {className: "slds-icon slds-input__icon slds-input__icon_left slds-icon-text-default", viewBox: "0 0 520 520"},
                    h("use", {xlinkHref: "symbols.svg#search"})),
                  h("input", {
                    ref: el => { this.inputEl = el; },
                    type: "search",
                    className: "slds-input",
                    placeholder: list ? "Start typing a " + typeInfo.singular + " name…" : "Loading " + typeInfo.plural + "…",
                    value: this.state.input,
                    autoFocus: true,
                    autoComplete: "off",
                    disabled: !list,
                    onChange: this.onInput,
                    onKeyDown: this.onInputKeyDown,
                    onFocus: this.onFocus,
                    onBlur: this.onBlur,
                  })
                ),
                this.renderDropdown()
              ),
              h("div", {className: "av-count slds-text-body_small slds-text-color_weak slds-p-bottom_x-small"},
                list ? formatNumber(list.length) + " " + typeInfo.plural : "")
            )
          ),
          model.mode === "search" && h("div", {
            ref: el => { this.bodyEl = el; },
            className: "slds-card__body slds-card__body_inner",
            style: {flex: "1", display: "flex", flexDirection: "column", overflowY: "auto", minHeight: 0},
          }, this.renderSearchResults()),
          model.mode === "view" && h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1", display: "flex", flexDirection: "column", overflowY: "auto", minHeight: 0}},
            model.errorMessages.length > 0 &&
              h("div", {className: "slds-notify slds-notify_alert slds-theme_error slds-m-bottom_small", role: "alert"},
                model.errorMessages[model.errorMessages.length - 1]),
            !sel && !model.loadingDetail && h("div", {className: "av-empty"},
              list
                ? "Pick a " + typeInfo.singular + " to view its source code. Type part of the name, or press ↓ in the search box to browse the full list."
                : "Loading " + typeInfo.plural + "…"),
            !sel && model.loadingDetail && h("div", {className: "av-empty"}, "Loading source code…"),
            sel && this.renderMeta(sel),
            sel && this.renderToolbar(sel),
            sel && this.renderCode(sel)
          )
        )
      )
    );
  }
}

{
  let args = new URLSearchParams(location.search.slice(1));
  let sfHost = args.get("host");
  initButton(sfHost, true);
  sfConn.getSession(sfHost).then(() => {
    let root = document.getElementById("root");
    let vm = new Model(sfHost);
    // Optional deep link: &type=ApexClass|ApexTrigger&id=...&name=...&find=...&line=...
    const deepId = args.get("id");
    const deepType = args.get("type") || "ApexClass";
    const openDeepLink = deepId && /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(deepId) && TYPES[deepType];
    if (openDeepLink) {
      vm.initialName = args.get("name") || "";
      vm.findQuery = args.get("find") || "";
      vm.targetLine = parseInt(args.get("line"), 10) || 0;
      if (deepType !== vm.type) {
        vm.type = deepType;
        vm.loadList(deepType);
      }
    }
    // Optional deep link to search mode: &mode=search&q=...&case=1&word=1&regex=1&comments=0
    const deepSearch = args.get("mode") === "search";
    if (deepSearch) {
      vm.mode = "search";
      vm.search.input = args.get("q") || "";
      vm.search.matchCase = args.get("case") === "1";
      vm.search.wholeWord = args.get("word") === "1";
      vm.search.regex = args.get("regex") === "1";
      vm.search.ignoreComments = args.get("comments") === "0";
    }
    vm.reactCallback = cb => {
      ReactDOM.render(h(App, {vm}), root, cb);
    };
    ReactDOM.render(h(App, {vm}), root);
    if (openDeepLink && !deepSearch) {
      vm.selectRecord({id: deepId, fullName: vm.initialName || deepId});
    }
    if (deepSearch && vm.search.input.trim().length >= 2) {
      vm.runSearch(false);
    }
  });
}
