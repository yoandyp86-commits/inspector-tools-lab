/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {PageHeader} from "./components/PageHeader.js";
import {UserInfoModel, copyToClipboard} from "./utils.js";
/* global initButton */

let h = React.createElement;

const MIN_QUERY = 5;            // minimum normalized length of the searched text
const MIN_FRAGMENT = 15;        // minimum length of a source text to count as "part of the error"
const MIN_FRAGMENT_RATIO = 0.3; // ...and minimum share of the searched text it must cover
const MAX_VR_DETAILS = 25;      // validation rules whose formula is downloaded (one call each)
const MAX_HITS_PER_ITEM = 10;   // hits shown per Apex class / flow
const FLOW_CONCURRENCY = 5;
const SNIPPET_CONTEXT = 3;
const RECORD_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const STACK_FRAME_RE = /\b(Class|Trigger)\.([A-Za-z0-9_.]+): line (\d+), column \d+/g;
const ERROR_RECORD_ID_RE = /\bwith id ([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)\b/i;
const MAX_RELATION_DEPTH = 5;

const EDIT_CONTEXT_FUNCTIONS = ["ISCHANGED", "PRIORVALUE", "ISNEW", "ISCLONE"];
const FORMULA_KEYWORDS = new Set(["TRUE", "FALSE", "NULL", "AND", "OR", "NOT"]);

const APEX_TYPES = [
  {type: "ApexClass", label: "Class", setupPath: "ApexClasses", soql: "SELECT Id, Name, Body FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name"},
  {type: "ApexTrigger", label: "Trigger", setupPath: "ApexTriggers", soql: "SELECT Id, Name, TableEnumOrId, Body FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY Name"},
];

// ---------- Text helpers ----------

function normalize(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Decodes the HTML entities that debug logs use (e.g. &quot; instead of "). */
function decodeEntities(s) {
  return (s || "")
    .replace(/&quot;|&#34;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Removes the wrappers Salesforce adds around a user-facing error message. */
function cleanError(raw) {
  const lines = decodeEntities(raw).replace(STACK_FRAME_RE, " ").replace(/\bAnonymousBlock: line \d+, column \d+/g, " ")
    .replace(/\r\n?/g, "\n").split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !/^(Class|Trigger|AnonymousBlock)\.[\w.$]+: line \d+/i.test(l) && !/^External entry point$/i.test(l));
  let s = lines.join(" ");
  s = s.replace(/^\d{2}:\d{2}:\d{2}\.\d+ \(\d+\)\|[A-Z_]+\|(\[\d+\]\|)?/, ""); // pasted debug log line
  s = s.replace(/^Review the errors on this page\.?\s*/i, "");
  s = s.replace(/^.*first error:\s*/i, "");
  s = s.replace(/^.*\bcaused by:\s*/i, "");
  s = s.replace(/^(System\.)?[\w.]*Exception:\s*/, "");
  let prev;
  do {
    prev = s;
    s = s.replace(/^[A-Z][A-Z0-9]*_[A-Z0-9_]+\s*[,:]\s*/, "");
  } while (s !== prev);
  s = s.replace(/:\s*\[[^\]]*\]\s*$/, "");
  s = s.replace(/^Error:\s*/i, "");
  return s.trim();
}

/** "contains": the source contains the searched text. "fragment": the source text is part of the searched text. */
function isFragment(sourceNorm, queryNorm) {
  return sourceNorm.length >= MIN_FRAGMENT
    && sourceNorm.length >= queryNorm.length * MIN_FRAGMENT_RATIO
    && queryNorm.includes(sourceNorm);
}

function matchText(sourceNorm, queryNorm) {
  if (!sourceNorm || !queryNorm) return null;
  if (sourceNorm.includes(queryNorm)) return "contains";
  if (isFragment(sourceNorm, queryNorm)) return "fragment";
  return null;
}

/** Extracts the Apex stack frames (Class.X.method: line N / Trigger.X: line N) from the pasted text. */
function parseStackFrames(raw) {
  const out = [];
  const seen = new Set();
  const re = new RegExp(STACK_FRAME_RE.source, "g");
  let m;
  while ((m = re.exec(raw || ""))) {
    const parts = m[2].split(".");
    const kind = m[1];
    const frame = {
      kind,
      name: parts[0],
      method: kind === "Class" ? parts.slice(1).join(".") : "",
      line: parseInt(m[3], 10),
    };
    const key = frame.kind + "|" + frame.name + "|" + frame.method + "|" + frame.line;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(frame);
  }
  return out;
}

/** Same as matchText, but splits label values on {0}, {1}… placeholders. */
function matchLabelValue(value, queryNorm) {
  const whole = matchText(normalize(value), queryNorm);
  if (whole) return whole;
  const fragments = value.split(/\{\d+\}/).map(normalize).filter(Boolean);
  return fragments.some(f => isFragment(f, queryNorm)) ? "fragment" : null;
}

function matchLabel(match) {
  return match === "contains" ? "Contains the error text" : "Part of the error text";
}

/** Extracts string literals from Apex code, skipping comments. */
function extractApexLiterals(body) {
  const out = [];
  const n = body.length;
  let i = 0;
  while (i < n) {
    const c = body[i];
    if (c === "/" && body[i + 1] === "/") {
      const e = body.indexOf("\n", i);
      i = e === -1 ? n : e;
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      const e = body.indexOf("*/", i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let val = "";
      while (j < n && body[j] !== "'" && body[j] !== "\n") {
        if (body[j] === "\\" && j + 1 < n) {
          const nx = body[j + 1];
          val += nx === "n" ? "\n" : nx === "t" ? "\t" : nx;
          j += 2;
        } else {
          val += body[j];
          j++;
        }
      }
      out.push({value: val, index: i});
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

function lineOf(body, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (body.charCodeAt(i) === 10) line++;
  return line;
}

function snippetOf(lines, line) {
  const start = Math.max(1, line - SNIPPET_CONTEXT);
  const end = Math.min(lines.length, line + SNIPPET_CONTEXT);
  const out = [];
  for (let l = start; l <= end; l++) out.push({line: l, text: lines[l - 1], hit: l === line});
  return out;
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
}

function truncate(s, max) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Collects the field references, context variables and edit-context functions used by a formula. */
function extractFormulaRefs(formula) {
  const cleaned = formula
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ");
  const refs = new Set();
  const context = new Set();
  const editFns = new Set();
  const re = /(\$?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(\s*\()?/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const tok = m[1];
    if (m[2]) {
      const up = tok.toUpperCase();
      if (EDIT_CONTEXT_FUNCTIONS.includes(up)) editFns.add(up);
      continue;
    }
    if (FORMULA_KEYWORDS.has(tok.toUpperCase())) continue;
    if (tok.startsWith("$")) {
      const parts = tok.split(".");
      if (parts[0].toLowerCase() === "$recordtype" && parts.length > 1) {
        refs.add("RecordType." + parts.slice(1).join("."));
      } else {
        context.add(parts.slice(0, 2).join("."));
      }
      continue;
    }
    refs.add(tok);
  }
  return {refs: Array.from(refs), context: Array.from(context), editFns: Array.from(editFns)};
}

function valueAt(record, path) {
  let cur = record;
  for (const p of path.split(".")) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur;
}

function formatValue(v) {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

class Model {
  constructor(sfHost) {
    this.reactCallback = null;
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.title = "Error Tracker";
    this.errorMessages = [];
    this.warnings = [];

    this.inputs = {error: "", recordId: "", includeFlows: false};
    this.running = false;
    this.progress = null;       // {label, done, total}
    this.hasSearched = false;
    this.searched = null;       // {cleaned, recordId, includeFlows}
    this.results = {stack: [], validationRules: [], apex: [], labels: [], flows: []};
    this.recordIdFromError = false;
    this.filter = "";

    this.cache = {
      validationRules: null,
      vrDetails: new Map(),
      apex: null,
      labels: null,
      flows: null,
      describes: new Map(),
    };

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
  }

  didUpdate(cb) {
    if (this.reactCallback) { this.reactCallback(cb); }
  }

  // ---------- Query helpers ----------

  queryUrl(soql, tooling) {
    return "/services/data/v" + apiVersion + (tooling ? "/tooling" : "") + "/query/?q=" + encodeURIComponent(soql);
  }

  async queryAll(soql, {tooling = false, onPage = null} = {}) {
    let url = this.queryUrl(soql, tooling);
    const out = [];
    while (url) {
      const res = await sfConn.rest(url);
      const recs = res.records || [];
      out.push(...recs);
      if (onPage) onPage(recs);
      url = res.nextRecordsUrl || null;
    }
    return out;
  }

  async getDescribe(objName) {
    const key = objName.toLowerCase();
    if (!this.cache.describes.has(key)) {
      const promise = sfConn.rest("/services/data/v" + apiVersion + "/sobjects/" + encodeURIComponent(objName) + "/describe");
      this.cache.describes.set(key, promise);
      promise.catch(() => this.cache.describes.delete(key));
    }
    return this.cache.describes.get(key);
  }

  clearCache() {
    this.cache.validationRules = null;
    this.cache.vrDetails = new Map();
    this.cache.apex = null;
    this.cache.labels = null;
    this.cache.flows = null;
    this.cache.describes = new Map();
    this.didUpdate();
  }

  setProgress(label, done, total) {
    this.progress = {label, done, total};
    this.didUpdate();
  }

  // ---------- Loaders (cached for the page session) ----------

  async loadValidationRules() {
    if (!this.cache.validationRules) {
      this.setProgress("Loading validation rules", 0, 0);
      this.cache.validationRules = await this.queryAll(
        "SELECT Id, ValidationName, Active, ErrorMessage, ErrorDisplayField, NamespacePrefix FROM ValidationRule",
        {tooling: true});
    }
    return this.cache.validationRules;
  }

  async getVrDetail(id) {
    if (!this.cache.vrDetails.has(id)) {
      const recs = await this.queryAll("SELECT Id, FullName, Metadata FROM ValidationRule WHERE Id = '" + id + "'", {tooling: true});
      this.cache.vrDetails.set(id, recs[0] || null);
    }
    return this.cache.vrDetails.get(id);
  }

  async loadLabels() {
    if (this.cache.labels) return this.cache.labels;
    this.setProgress("Loading custom labels", 0, 0);
    const recs = await this.queryAll("SELECT Id, Name, NamespacePrefix, Value, Language FROM ExternalString", {tooling: true});
    const labels = recs.map(r => ({
      id: r.Id,
      name: r.Name,
      fullName: r.NamespacePrefix ? r.NamespacePrefix + "__" + r.Name : r.Name,
      value: r.Value || "",
      language: r.Language || "",
      translations: [],
    }));
    try {
      const byId = new Map(labels.map(l => [l.id, l]));
      const tr = await this.queryAll("SELECT ExternalStringId, Language, Value FROM ExternalStringLocalization", {tooling: true});
      for (const t of tr) {
        const l = byId.get(t.ExternalStringId);
        if (l && t.Value) l.translations.push({language: t.Language, value: t.Value});
      }
    } catch (err) {
      console.error(err);
      this.warnings.push("Custom label translations could not be loaded (" + err.message + "). Only master values were searched.");
    }
    this.cache.labels = labels;
    return labels;
  }

  async loadApex() {
    if (this.cache.apex) return this.cache.apex;
    let total = 0;
    for (const def of APEX_TYPES) {
      const res = await sfConn.rest(this.queryUrl("SELECT COUNT() FROM " + def.type + " WHERE NamespacePrefix = null", false));
      total += res.totalSize || 0;
    }
    this.setProgress("Downloading Apex code", 0, total);
    const out = [];
    for (const def of APEX_TYPES) {
      await this.queryAll(def.soql, {
        onPage: recs => {
          for (const r of recs) {
            const body = (r.Body || "").replace(/\r\n?/g, "\n");
            if (body.trim() === "(hidden)") continue;
            out.push({
              type: def.type,
              typeLabel: def.label,
              setupPath: def.setupPath,
              id: r.Id,
              name: r.Name,
              object: r.TableEnumOrId || "",
              body,
              isTest: def.type === "ApexClass" && /@istest\b/i.test(body),
              literals: null,
              lines: null,
            });
          }
          this.setProgress("Downloading Apex code", Math.min(this.progress.done + recs.length, total), total);
        },
      });
    }
    this.cache.apex = out;
    return out;
  }

  async loadFlows() {
    if (this.cache.flows) return this.cache.flows;
    this.setProgress("Loading active flows", 0, 0);
    const defs = await this.queryAll(
      "SELECT Id, DeveloperName, ActiveVersionId FROM FlowDefinition WHERE ActiveVersionId != null",
      {tooling: true});
    const flows = new Array(defs.length);
    let next = 0;
    let done = 0;
    this.setProgress("Downloading active flow versions", 0, defs.length);
    const worker = async () => {
      while (next < defs.length) {
        const idx = next++;
        const d = defs[idx];
        try {
          const recs = await this.queryAll("SELECT Id, Metadata FROM Flow WHERE Id = '" + d.ActiveVersionId + "'", {tooling: true});
          const md = recs[0] && recs[0].Metadata;
          flows[idx] = {versionId: d.ActiveVersionId, name: d.DeveloperName, label: (md && md.label) || d.DeveloperName, metadata: md || null};
        } catch (err) {
          console.error(err);
          flows[idx] = {versionId: d.ActiveVersionId, name: d.DeveloperName, label: d.DeveloperName, metadata: null, error: err.message};
        }
        done++;
        this.setProgress("Downloading active flow versions", done, defs.length);
      }
    };
    await Promise.all(Array.from({length: Math.min(FLOW_CONCURRENCY, defs.length)}, worker));
    const failed = flows.filter(f => f.error).length;
    if (failed) this.warnings.push(failed + " flow(s) could not be downloaded and were skipped.");
    this.cache.flows = flows;
    return flows;
  }

  // ---------- Search ----------

  async trace() {
    if (this.running) return;
    this.errorMessages = [];
    this.warnings = [];
    const cleaned = cleanError(this.inputs.error);
    const q = normalize(cleaned);
    if (q.length < MIN_QUERY) {
      this.errorMessages.push("Paste the error message (at least " + MIN_QUERY + " characters after cleaning).");
      this.didUpdate();
      return;
    }
    this.recordIdFromError = false;
    if (!this.inputs.recordId.trim()) {
      const idMatch = this.inputs.error.match(ERROR_RECORD_ID_RE);
      if (idMatch) {
        this.inputs.recordId = idMatch[1];
        this.recordIdFromError = true;
      }
    }
    const recordId = this.inputs.recordId.trim();
    if (recordId && !RECORD_ID_RE.test(recordId)) {
      this.errorMessages.push("The record Id must have 15 or 18 alphanumeric characters.");
      this.didUpdate();
      return;
    }
    const includeFlows = this.inputs.includeFlows;
    this.running = true;
    this.spinnerCount++;
    this.searched = {cleaned, recordId, includeFlows};
    this.didUpdate();

    const frames = parseStackFrames(this.inputs.error);
    const results = {stack: frames.map(f => Object.assign({found: false}, f)), validationRules: [], apex: [], labels: [], flows: []};
    const step = async (name, fn) => {
      try {
        await fn();
      } catch (err) {
        console.error(err);
        this.warnings.push("Error searching " + name + ": " + err.message);
      }
    };
    try {
      await step("validation rules", () => this.searchValidationRules(q, recordId, results));
      await step("custom labels", () => this.searchLabels(q, results));
      await step("Apex code", () => this.searchApex(q, results));
      if (frames.length) await step("the stack trace", () => this.resolveStack(results));
      if (includeFlows) await step("flows", () => this.searchFlows(q, results));
      this.results = results;
      this.hasSearched = true;
      this.filter = "";
    } finally {
      this.progress = null;
      this.running = false;
      this.spinnerCount--;
      this.didUpdate();
    }
  }

  async searchValidationRules(q, recordId, results) {
    const all = await this.loadValidationRules();
    const matched = [];
    for (const r of all) {
      const match = matchText(normalize(r.ErrorMessage), q);
      if (match) matched.push({r, match});
    }
    matched.sort((x, y) => (y.r.Active ? 1 : 0) - (x.r.Active ? 1 : 0));
    if (matched.length > MAX_VR_DETAILS) {
      this.warnings.push(matched.length + " validation rules match. Formulas are only loaded for the first " + MAX_VR_DETAILS + "; paste a longer part of the message to narrow it down.");
    }
    for (let i = 0; i < matched.length; i++) {
      const {r, match} = matched[i];
      const vr = {
        id: r.Id,
        name: r.ValidationName,
        object: "",
        active: !!r.Active,
        message: r.ErrorMessage || "",
        errorDisplayField: r.ErrorDisplayField || "",
        match,
        formula: "",
        description: "",
        url: "",
        evaluation: null,
      };
      if (i < MAX_VR_DETAILS) {
        this.setProgress("Loading validation rule formulas", i + 1, Math.min(matched.length, MAX_VR_DETAILS));
        try {
          const detail = await this.getVrDetail(r.Id);
          if (detail) {
            const md = detail.Metadata || {};
            vr.object = (detail.FullName || "").split(".")[0];
            vr.formula = md.errorConditionFormula || "";
            vr.description = md.description || "";
            vr.errorDisplayField = vr.errorDisplayField || md.errorDisplayField || "";
          }
        } catch (err) {
          console.error(err);
          vr.formula = "";
          this.warnings.push("Could not load the formula of '" + r.ValidationName + "': " + err.message);
        }
        if (recordId && vr.formula && vr.object) {
          vr.evaluation = await this.evaluateRule(vr, recordId);
        }
      }
      if (vr.object) {
        vr.url = this.sfLink + "/lightning/setup/ObjectManager/" + encodeURIComponent(vr.object) + "/ValidationRules/" + vr.id + "/view";
      }
      results.validationRules.push(vr);
    }
  }

  /** Resolves a formula path (e.g. Account.Owner.Name) into a SOQL path, or null when it is not a valid field path. */
  async resolvePath(objName, path) {
    const parts = path.split(".");
    if (parts.length > MAX_RELATION_DEPTH + 1) return null;
    let desc = await this.getDescribe(objName);
    const soqlParts = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].toLowerCase();
      if (i === parts.length - 1) {
        const f = (desc.fields || []).find(x => x.name.toLowerCase() === p);
        if (!f) return null;
        soqlParts.push(f.name);
        return soqlParts.join(".");
      }
      const rel = (desc.fields || []).find(x => (x.relationshipName || "").toLowerCase() === p);
      if (!rel || !rel.referenceTo || rel.referenceTo.length !== 1) return null;
      soqlParts.push(rel.relationshipName);
      desc = await this.getDescribe(rel.referenceTo[0]);
    }
    return null;
  }

  async evaluateRule(vr, recordId) {
    try {
      const desc = await this.getDescribe(vr.object);
      if (!desc.keyPrefix || !recordId.startsWith(desc.keyPrefix)) {
        return {status: "skip", message: "The record Id does not belong to " + vr.object + "."};
      }
      const {refs, context, editFns} = extractFormulaRefs(vr.formula);
      const resolved = [];
      const unresolved = [];
      for (const ref of refs) {
        const soqlPath = await this.resolvePath(desc.name, ref);
        if (soqlPath) {
          if (!resolved.some(x => x.soqlPath.toLowerCase() === soqlPath.toLowerCase())) resolved.push({ref, soqlPath});
        } else {
          unresolved.push(ref);
        }
      }
      let values = [];
      if (resolved.length) {
        const fields = ["Id"].concat(resolved.map(x => x.soqlPath).filter(p => p.toLowerCase() !== "id"));
        const recs = await this.queryAll("SELECT " + fields.join(", ") + " FROM " + desc.name + " WHERE Id = '" + recordId + "'");
        if (!recs[0]) return {status: "error", message: "Record " + recordId + " was not found (or you cannot see it)."};
        values = resolved.map(x => ({field: x.ref, value: formatValue(valueAt(recs[0], x.soqlPath))}));
      }
      return {status: "ok", values, unresolved, context, editFns};
    } catch (err) {
      console.error(err);
      return {status: "error", message: err.message};
    }
  }

  async searchLabels(q, results) {
    const labels = await this.loadLabels();
    for (const l of labels) {
      const texts = [{language: l.language, value: l.value}].concat(l.translations);
      let match = null;
      let matchedLanguage = "";
      for (const t of texts) {
        const m = matchLabelValue(t.value, q);
        if (m) {
          match = m;
          matchedLanguage = t.language;
          break;
        }
      }
      if (match) {
        results.labels.push({
          id: l.id,
          name: l.fullName,
          value: l.value,
          language: l.language,
          translations: l.translations,
          match,
          matchedLanguage,
          url: this.sfLink + "/lightning/setup/ExternalStrings/page?address=%2F" + l.id,
          usages: [],
        });
      }
    }
  }

  /** Link to the Apex Code Viewer, highlighting the given line (its trimmed text is used as the search term). */
  apexViewerUrl(item, line) {
    const p = new URLSearchParams();
    p.set("host", this.sfHost);
    p.set("type", item.type);
    p.set("id", item.id);
    p.set("name", item.name);
    if (line) {
      if (!item.lines) item.lines = item.body.split("\n");
      const text = (item.lines[line - 1] || "").trim().slice(0, 80);
      if (text) {
        p.set("find", text);
        p.set("line", String(line));
      }
    }
    return "apex-viewer.html?" + p.toString();
  }

  setupUrlFor(item) {
    return this.sfLink + "/lightning/setup/" + item.setupPath + "/page?address=%2F" + item.id;
  }

  async resolveStack(results) {
    const apex = await this.loadApex();
    results.stack = results.stack.map(frame => {
      const type = frame.kind === "Class" ? "ApexClass" : "ApexTrigger";
      const item = apex.find(a => a.type === type && a.name.toLowerCase() === frame.name.toLowerCase());
      if (!item) return Object.assign({}, frame, {found: false});
      if (!item.lines) item.lines = item.body.split("\n");
      return Object.assign({}, frame, {
        found: true,
        name: item.name,
        code: (item.lines[frame.line - 1] || "").trim(),
        snippet: snippetOf(item.lines, frame.line),
        viewerUrl: this.apexViewerUrl(item, frame.line),
        setupUrl: this.setupUrlFor(item),
      });
    });
  }

  async searchApex(q, results) {
    const apex = await this.loadApex();
    const labelsByName = new Map(results.labels.map(l => [l.name.toLowerCase(), l]));
    this.setProgress("Searching Apex code", 0, apex.length);
    apex.forEach((item, idx) => {
      if (!item.literals) item.literals = extractApexLiterals(item.body);
      const hits = [];
      for (const lit of item.literals) {
        const m = matchText(normalize(lit.value), q);
        if (m) hits.push({index: lit.index, via: matchLabel(m), text: lit.value});
      }
      if (labelsByName.size) {
        const re = /\b(?:System\s*\.\s*)?Label\s*\.\s*([A-Za-z0-9_]+)/gi;
        let m;
        while ((m = re.exec(item.body))) {
          const label = labelsByName.get(m[1].toLowerCase());
          if (label) hits.push({index: m.index, via: "Uses Custom Label " + label.name, text: m[0], label});
        }
      }
      if (hits.length) {
        if (!item.lines) item.lines = item.body.split("\n");
        hits.sort((a, b) => a.index - b.index);
        const seen = new Set();
        const shown = [];
        for (const hit of hits) {
          hit.line = lineOf(item.body, hit.index);
          const key = hit.line + "|" + hit.via;
          if (seen.has(key)) continue;
          seen.add(key);
          if (hit.label) hit.label.usages.push({name: item.name, typeLabel: item.typeLabel, line: hit.line, viewerUrl: this.apexViewerUrl(item, hit.line)});
          if (shown.length < MAX_HITS_PER_ITEM) {
            hit.snippet = snippetOf(item.lines, hit.line);
            shown.push(hit);
          }
        }
        results.apex.push({
          type: item.type,
          typeLabel: item.typeLabel,
          id: item.id,
          name: item.name,
          object: item.object,
          isTest: item.isTest,
          totalHits: seen.size,
          hits: shown,
          viewerUrl: this.apexViewerUrl(item, shown[0].line),
          setupUrl: this.setupUrlFor(item),
        });
      }
      if (idx % 50 === 0) this.setProgress("Searching Apex code", idx, apex.length);
    });
    results.apex.sort((a, b) => (a.isTest ? 1 : 0) - (b.isTest ? 1 : 0) || a.name.localeCompare(b.name));
  }

  async searchFlows(q, results) {
    const flows = await this.loadFlows();
    const labelNames = new Set(results.labels.map(l => l.name.toLowerCase()));
    for (const flow of flows) {
      if (!flow.metadata) continue;
      const strings = [];
      const walk = (node, ctx) => {
        if (typeof node === "string") {
          strings.push({text: node, ctx});
        } else if (Array.isArray(node)) {
          node.forEach(n => walk(n, ctx));
        } else if (node && typeof node === "object") {
          for (const [k, v] of Object.entries(node)) {
            if (!ctx && Array.isArray(v) && v.length && v[0] && typeof v[0] === "object") {
              v.forEach(item => walk(item, {collection: k, name: (item && (item.name || item.label)) || ""}));
            } else {
              walk(v, ctx);
            }
          }
        }
      };
      walk(flow.metadata, null);
      const hits = [];
      const seen = new Set();
      for (const s of strings) {
        let via = null;
        const m = matchText(normalize(s.text), q);
        if (m) via = matchLabel(m);
        if (!via && labelNames.size) {
          const re = /\$Label\.([A-Za-z0-9_]+)/gi;
          let lm;
          while ((lm = re.exec(s.text))) {
            if (labelNames.has(lm[1].toLowerCase())) { via = "Uses Custom Label " + lm[1]; break; }
          }
        }
        if (!via) continue;
        const element = s.ctx ? s.ctx.collection + (s.ctx.name ? " › " + s.ctx.name : "") : "(flow properties)";
        const key = element + "|" + s.text;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({element, via, text: s.text});
      }
      if (hits.length) {
        results.flows.push({
          versionId: flow.versionId,
          name: flow.name,
          label: flow.label,
          totalHits: hits.length,
          hits: hits.slice(0, MAX_HITS_PER_ITEM),
          url: this.sfLink + "/builder_platform_interaction/flowBuilder.app?flowId=" + flow.versionId,
        });
      }
    }
    results.flows.sort((a, b) => a.label.localeCompare(b.label));
  }

  // ---------- View helpers ----------

  visibleResults() {
    const f = this.filter.trim().toLowerCase();
    const r = this.results;
    if (!f) return r;
    const has = (...parts) => parts.join(" ").toLowerCase().includes(f);
    return {
      stack: r.stack.filter(x => has(x.kind, x.name, x.method, x.code || "")),
      validationRules: r.validationRules.filter(x => has(x.name, x.object, x.message, x.formula)),
      apex: r.apex.filter(x => has(x.name, x.object, x.hits.map(hh => hh.text).join(" "))),
      labels: r.labels.filter(x => has(x.name, x.value)),
      flows: r.flows.filter(x => has(x.label, x.name, x.hits.map(hh => hh.element + " " + hh.text).join(" "))),
    };
  }

  flatRows() {
    const v = this.visibleResults();
    const rows = [];
    for (const x of v.stack) {
      rows.push({type: "Stack " + x.kind, name: x.name + (x.method ? "." + x.method : ""), location: "line " + x.line, match: "Stack trace", text: x.code || "", formula: "", link: x.setupUrl || ""});
    }
    for (const x of v.validationRules) {
      rows.push({type: "Validation Rule", name: x.name, location: x.object + (x.active ? "" : " (inactive)"), match: matchLabel(x.match), text: x.message, formula: x.formula, link: x.url});
    }
    for (const x of v.apex) {
      for (const hit of x.hits) {
        rows.push({type: "Apex " + x.typeLabel, name: x.name, location: "line " + hit.line, match: hit.via, text: hit.text, formula: "", link: x.setupUrl});
      }
    }
    for (const x of v.labels) {
      rows.push({type: "Custom Label", name: x.name, location: x.language, match: matchLabel(x.match), text: x.value, formula: "", link: x.url});
    }
    for (const x of v.flows) {
      for (const hit of x.hits) {
        rows.push({type: "Flow", name: x.label, location: hit.element, match: hit.via, text: hit.text, formula: "", link: x.url});
      }
    }
    return rows;
  }

  copyAsCsv() {
    const header = ["Type", "Name", "Location", "Match", "Text", "Formula", "Link"];
    const lines = this.flatRows().map(r => [r.type, r.name, r.location, r.match, r.text, r.formula, r.link].map(csvCell).join(","));
    copyToClipboard([header.join(",")].concat(lines).join("\n"));
  }

  copyAsJson() {
    const v = this.visibleResults();
    const data = {
      searchedText: this.searched.cleaned,
      recordId: this.searched.recordId || null,
      stack: v.stack.map(x => ({kind: x.kind, name: x.name, method: x.method, line: x.line, code: x.code || null})),
      validationRules: v.validationRules,
      apex: v.apex.map(x => ({type: x.type, name: x.name, object: x.object, isTest: x.isTest, hits: x.hits.map(hh => ({line: hh.line, match: hh.via, text: hh.text}))})),
      customLabels: v.labels.map(x => ({name: x.name, value: x.value, language: x.language, usages: x.usages.map(u => ({name: u.name, line: u.line}))})),
      flows: v.flows.map(x => ({name: x.name, label: x.label, hits: x.hits})),
    };
    copyToClipboard(JSON.stringify(data, null, 2));
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.onTrace = this.onTrace.bind(this);
    this.onKeyDownRecord = this.onKeyDownRecord.bind(this);
    this.onKeyDownError = this.onKeyDownError.bind(this);
    this.onFilter = this.onFilter.bind(this);
    this.onCopyCsv = this.onCopyCsv.bind(this);
    this.onCopyJson = this.onCopyJson.bind(this);
    this.onClearCache = this.onClearCache.bind(this);
  }

  onTrace() { this.props.vm.trace(); }
  onKeyDownRecord(e) { if (e.key === "Enter") { e.preventDefault(); this.onTrace(); } }
  onKeyDownError(e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.onTrace(); } }
  onFilter(e) { this.props.vm.filter = e.target.value; this.props.vm.didUpdate(); }
  onCopyCsv() { this.props.vm.copyAsCsv(); }
  onCopyJson() { this.props.vm.copyAsJson(); }
  onClearCache() { this.props.vm.clearCache(); }

  setInput(key, value) {
    this.props.vm.inputs[key] = value;
    this.props.vm.didUpdate();
  }

  renderProgress() {
    const p = this.props.vm.progress;
    if (!p) return null;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    return h("div", {className: "et-progress slds-m-bottom_small"},
      h("div", {className: "et-progress-label"}, p.label + (p.total ? " · " + p.done + " / " + p.total : "…")),
      h("div", {className: "slds-progress-bar", role: "progressbar"},
        h("span", {className: "slds-progress-bar__value" + (p.total ? "" : " et-indeterminate"), style: {width: (p.total ? pct : 100) + "%"}})
      )
    );
  }

  renderSectionTitle(label, count) {
    return h("h3", {className: "slds-text-heading_small et-section-title"}, label, h("span", {className: "et-count"}, count + " result(s)"));
  }

  renderEvaluation(ev) {
    if (!ev) return null;
    if (ev.status === "skip") return h("div", {className: "et-note"}, ev.message);
    if (ev.status === "error") return h("div", {className: "et-note et-note-error"}, "Could not read the record values: " + ev.message);
    return h("div", {className: "et-eval"},
      h("div", {className: "et-eval-title"}, "Current values of the record"),
      ev.values.length > 0
        ? h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered et-eval-table"},
          h("thead", {}, h("tr", {}, h("th", {}, "Field"), h("th", {}, "Value"))),
          h("tbody", {}, ev.values.map((v, i) =>
            h("tr", {key: i}, h("td", {}, h("code", {}, v.field)), h("td", {className: v.value === "(empty)" ? "et-empty-value" : ""}, v.value)))))
        : h("div", {className: "et-note"}, "The formula does not reference fields of the record."),
      ev.editFns.length > 0 && h("div", {className: "et-note"},
        "Not evaluable without an edit context: " + ev.editFns.join(", ") + " (they depend on the change being saved)."),
      ev.context.length > 0 && h("div", {className: "et-note"},
        "Depends on the running user or org: " + ev.context.join(", ") + "."),
      ev.unresolved.length > 0 && h("div", {className: "et-note"},
        "Not resolved as fields (ignored): " + ev.unresolved.join(", ") + ".")
    );
  }

  renderValidationRules(list) {
    return h("div", {className: "slds-m-bottom_medium"},
      this.renderSectionTitle("Validation Rules", list.length),
      list.length === 0 ? h("div", {className: "et-empty-small"}, "No validation rule message matches.") :
        list.map(vr =>
          h("div", {key: vr.id, className: "et-card"},
            h("div", {className: "et-card-head"},
              vr.url ? h("a", {href: vr.url, target: "_blank", title: "Open in Setup"}, vr.name) : h("strong", {}, vr.name),
              vr.object && h("span", {className: "et-sub"}, vr.object),
              h("span", {className: "slds-badge " + (vr.active ? "et-badge-active" : "et-badge-inactive")}, vr.active ? "Active" : "Inactive"),
              h("span", {className: "slds-badge et-badge-match"}, matchLabel(vr.match))
            ),
            h("div", {className: "et-message"}, vr.message),
            vr.errorDisplayField && h("div", {className: "et-sub"}, "Shown on field: " + vr.errorDisplayField),
            vr.description && h("div", {className: "et-sub"}, vr.description),
            vr.formula
              ? h("pre", {className: "et-code"}, vr.formula)
              : h("div", {className: "et-note"}, "Formula not loaded."),
            this.renderEvaluation(vr.evaluation)
          ))
    );
  }

  renderSnippet(snippet) {
    return h("pre", {className: "et-code et-snippet"},
      snippet.map(l =>
        h("div", {key: l.line, className: l.hit ? "et-hit-line" : ""},
          h("span", {className: "et-line-no"}, l.line),
          l.text
        ))
    );
  }

  renderStack(list) {
    return h("div", {className: "slds-m-bottom_medium"},
      h("h3", {className: "slds-text-heading_small et-section-title"}, "Stack trace",
        h("span", {className: "et-count"}, list.length + " frame(s) · the first one is where the error was raised")),
      list.map((f, i) =>
        h("div", {key: i, className: "et-card" + (i === 0 ? " et-card-origin" : "")},
          h("div", {className: "et-card-head"},
            i === 0 && h("span", {className: "slds-badge et-badge-origin"}, "Origin"),
            f.found
              ? h("a", {href: f.viewerUrl, target: "_blank", title: "Open this line in Apex Code Viewer"}, f.name + (f.method ? "." + f.method : ""))
              : h("strong", {}, f.name + (f.method ? "." + f.method : "")),
            h("span", {className: "slds-badge et-badge-type"}, (f.kind === "Class" ? "Class" : "Trigger") + " · line " + f.line),
            f.found && h("a", {className: "et-setup-link", href: f.setupUrl, target: "_blank"}, "Setup")
          ),
          f.found
            ? this.renderSnippet(f.snippet)
            : h("div", {className: "et-note"}, "Source not available (managed package, or the Apex code could not be loaded).")
        ))
    );
  }

  renderApex(list) {
    return h("div", {className: "slds-m-bottom_medium"},
      this.renderSectionTitle("Apex", list.length),
      list.length === 0 ? h("div", {className: "et-empty-small"}, "No Apex class or trigger matches.") :
        list.map(item =>
          h("div", {key: item.id, className: "et-card"},
            h("div", {className: "et-card-head"},
              h("a", {href: item.viewerUrl, target: "_blank", title: "Open in Apex Code Viewer"}, item.name),
              h("span", {className: "slds-badge et-badge-type"}, item.typeLabel + (item.object ? " · " + item.object : "")),
              item.isTest && h("span", {className: "slds-badge et-badge-inactive"}, "Test"),
              h("a", {className: "et-setup-link", href: item.setupUrl, target: "_blank"}, "Setup")
            ),
            item.hits.map((hit, i) =>
              h("div", {key: i, className: "et-hit"},
                h("div", {className: "et-sub"}, "Line " + hit.line + " · " + hit.via),
                this.renderSnippet(hit.snippet)
              )),
            item.totalHits > item.hits.length && h("div", {className: "et-note"}, (item.totalHits - item.hits.length) + " more match(es) not shown.")
          ))
    );
  }

  renderLabels(list) {
    return h("div", {className: "slds-m-bottom_medium"},
      this.renderSectionTitle("Custom Labels", list.length),
      list.length === 0 ? h("div", {className: "et-empty-small"}, "No custom label matches.") :
        list.map(l =>
          h("div", {key: l.id, className: "et-card"},
            h("div", {className: "et-card-head"},
              h("a", {href: l.url, target: "_blank", title: "Open in Setup"}, l.name),
              h("span", {className: "et-sub"}, l.language),
              h("span", {className: "slds-badge et-badge-match"}, matchLabel(l.match) + (l.matchedLanguage && l.matchedLanguage !== l.language ? " (" + l.matchedLanguage + ")" : ""))
            ),
            h("div", {className: "et-message"}, l.value),
            l.usages.length > 0
              ? h("div", {className: "et-usages"},
                h("div", {className: "et-sub"}, "Used in Apex:"),
                l.usages.map((u, i) =>
                  h("div", {key: i}, h("a", {href: u.viewerUrl, target: "_blank"}, u.name), h("span", {className: "et-sub"}, " · " + u.typeLabel + " · line " + u.line))))
              : h("div", {className: "et-note"}, "Not referenced in Apex" + (this.props.vm.searched.includeFlows ? "" : " (flows not searched)") + ".")
          ))
    );
  }

  renderFlows(list) {
    return h("div", {className: "slds-m-bottom_medium"},
      this.renderSectionTitle("Flows (active versions)", list.length),
      list.length === 0 ? h("div", {className: "et-empty-small"}, "No active flow matches.") :
        list.map(f =>
          h("div", {key: f.versionId, className: "et-card"},
            h("div", {className: "et-card-head"},
              h("a", {href: f.url, target: "_blank", title: "Open in Flow Builder"}, f.label),
              h("span", {className: "et-sub"}, f.name)
            ),
            f.hits.map((hit, i) =>
              h("div", {key: i, className: "et-hit"},
                h("div", {className: "et-sub"}, hit.element + " · " + hit.via),
                h("div", {className: "et-message"}, truncate(hit.text, 300))
              )),
            f.totalHits > f.hits.length && h("div", {className: "et-note"}, (f.totalHits - f.hits.length) + " more match(es) not shown.")
          ))
    );
  }

  render() {
    const model = this.props.vm;
    document.title = model.title;
    const v = model.hasSearched ? model.visibleResults() : null;
    const total = v ? v.validationRules.length + v.apex.length + v.labels.length + v.flows.length : 0;
    const exportable = v ? total + v.stack.length : 0;
    return h("div", {},
      h(PageHeader, {
        pageTitle: "Error Tracker",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        ...model.userInfoModel.getProps()
      }),
      h("div", {className: "slds-m-top_xx-large sfir-page-container"},
        h("div", {className: "slds-card slds-m-around_medium", style: {flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0}},
          h("div", {className: "slds-card__header slds-p-horizontal_small slds-p-top_small et-form"},
            h("div", {className: "slds-form-element"},
              h("label", {className: "slds-form-element__label"}, "Error message (paste it as is)"),
              h("div", {className: "slds-form-element__control"},
                h("textarea", {
                  className: "slds-textarea",
                  rows: 3,
                  placeholder: "e.g. FIELD_CUSTOM_VALIDATION_EXCEPTION, You cannot close the order without a payment method: []",
                  value: model.inputs.error,
                  autoFocus: true,
                  onChange: e => this.setInput("error", e.target.value),
                  onKeyDown: this.onKeyDownError,
                })
              )
            ),
            h("div", {className: "et-row"},
              h("div", {className: "slds-form-element", style: {flex: "1"}},
                h("label", {className: "slds-form-element__label"}, "Record Id (optional)"),
                h("div", {className: "slds-form-element__control"},
                  h("input", {
                    type: "search",
                    className: "slds-input",
                    placeholder: "Shows the current values of the fields used by matching validation rules",
                    value: model.inputs.recordId,
                    onChange: e => this.setInput("recordId", e.target.value),
                    onKeyDown: this.onKeyDownRecord,
                  })
                )
              ),
              h("label", {className: "et-checkbox", title: "Downloads the metadata of every active flow (one call per flow). Slower."},
                h("input", {type: "checkbox", checked: model.inputs.includeFlows, onChange: e => this.setInput("includeFlows", e.target.checked)}),
                " Search also in Flows"
              ),
              h("button", {className: "slds-button slds-button_brand", disabled: model.running, onClick: this.onTrace}, model.running ? "Searching…" : "Trace"),
              h("button", {className: "slds-button slds-button_neutral", disabled: model.running, onClick: this.onClearCache, title: "Validation rules, labels, Apex and flows are cached while this page is open. Clear the cache to reload them."}, "Clear cache")
            )
          ),
          h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1", overflowY: "auto", minHeight: 0}},
            model.errorMessages.length > 0
              && h("div", {className: "slds-notify slds-notify_alert slds-theme_error slds-m-bottom_small", role: "alert"},
                model.errorMessages[model.errorMessages.length - 1]),
            model.warnings.map((w, i) =>
              h("div", {key: "w" + i, className: "slds-notify slds-notify_alert slds-theme_warning slds-m-bottom_x-small", role: "alert"}, w)),
            this.renderProgress(),
            !model.hasSearched && !model.running && h("div", {className: "et-empty"},
              "Paste an error message and press Trace (or Ctrl+Enter) to find the validation rules, Apex code, custom labels and, optionally, flows that produce it."),
            model.hasSearched && !model.running && h("div", {},
              h("div", {className: "et-toolbar"},
                h("div", {},
                  h("div", {className: "et-sub"}, "Searched text"),
                  h("code", {className: "et-searched"}, model.searched.cleaned),
                  h("div", {className: "et-sub slds-m-top_xx-small"}, h("strong", {}, total + " result(s)")),
                  model.recordIdFromError && h("div", {className: "et-sub"}, "Record Id taken from the error message: " + model.searched.recordId)
                ),
                h("div", {className: "et-toolbar-actions"},
                  h("input", {type: "search", className: "slds-input et-filter-input", placeholder: "Filter results", value: model.filter, onChange: this.onFilter}),
                  h("button", {className: "slds-button slds-button_neutral", disabled: exportable === 0, onClick: this.onCopyCsv, title: "Copy visible results as CSV"}, "Copy CSV"),
                  h("button", {className: "slds-button slds-button_neutral", disabled: exportable === 0, onClick: this.onCopyJson, title: "Copy visible results as JSON"}, "Copy JSON")
                )
              ),
              this.renderValidationRules(v.validationRules),
              v.stack.length > 0 && this.renderStack(v.stack),
              this.renderApex(v.apex),
              this.renderLabels(v.labels),
              model.searched.includeFlows && this.renderFlows(v.flows)
            )
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
    vm.reactCallback = cb => {
      ReactDOM.render(h(App, {vm}), root, cb);
    };
    ReactDOM.render(h(App, {vm}), root);
  });
}
