/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {PageHeader} from "./components/PageHeader.js";
import {UserInfoModel, downloadCsvFile, getStandardObjectNameField} from "./utils.js";
/* global initButton */

let h = React.createElement;

const RECORD_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const EXCLUDED_TYPES = ["address", "location", "base64"];
const SYSTEM_FIELDS = ["Id", "IsDeleted", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById",
  "SystemModstamp", "LastActivityDate", "LastViewedDate", "LastReferencedDate"];
const TRUNCATE_AT = 200;

function soqlString(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
}

function fold(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleString();
}

function sameId(a, b) {
  return !!a && !!b && a.substring(0, 15) === b.substring(0, 15);
}

/**
 * Name field to show for a lookup: {nf, assumed}, or null when the target has no name field.
 * assumed = true when "Name" is a default guess for a standard object not listed in the utils mapping.
 */
export function lookupNameField(f) {
  if (!f.relationshipName || !f.referenceTo || f.referenceTo.length === 0) return null;
  if (f.referenceTo.length > 1 || f.polymorphicForeignKey) return {nf: "Name", assumed: false};
  const target = f.referenceTo[0];
  if (target.endsWith("__c")) return {nf: "Name", assumed: false};
  const nf = getStandardObjectNameField(target);
  if (nf === "N/A") return {nf: "Name", assumed: true};
  return typeof nf === "string" ? {nf, assumed: false} : null;
}

export function formatValue(v, f) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(v);
  if (f.type === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const [y, m, d] = v.substring(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString();
  }
  if (f.type === "datetime" && typeof v === "string") return formatDateTime(v);
  return String(v);
}

/** True when two raw field values are equal for comparison purposes (empty and null are equal). */
export function sameValue(a, b, f) {
  const ea = a === null || a === undefined || a === "";
  const eb = b === null || b === undefined || b === "";
  if (ea || eb) return ea && eb;
  if (f.type === "reference" || f.type === "id") return sameId(String(a), String(b));
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

/** Builds one row per comparable field. names: {a: {field: name}, b: {...}} for lookups. */
export function buildRows(fields, recA, recB, names) {
  const rows = [];
  for (const f of fields) {
    if (EXCLUDED_TYPES.includes(f.type)) continue;
    const side = (rec, nm) => {
      const raw = rec[f.name];
      const isRef = f.type === "reference" && raw;
      return {
        text: isRef ? (nm[f.name] || raw) : formatValue(raw, f),
        id: isRef ? raw : null,
      };
    };
    rows.push({
      api: f.name,
      label: f.type === "reference" && / ID$/.test(f.label) ? f.label.slice(0, -3) : f.label,
      type: f.type,
      system: SYSTEM_FIELDS.includes(f.name),
      a: side(recA, names.a),
      b: side(recB, names.b),
      diff: !sameValue(recA[f.name], recB[f.name], f),
    });
  }
  return rows.sort((x, y) => x.label.localeCompare(y.label) || x.api.localeCompare(y.api));
}

export function filterRows(rows, {onlyDiff, hideSystem, search}) {
  const s = fold(search).trim();
  return rows.filter(r =>
    (!onlyDiff || r.diff)
    && (!hideSystem || !r.system)
    && (!s || fold(r.label).includes(s) || fold(r.api).includes(s)));
}

class Model {
  constructor(sfHost, id1, id2) {
    this.reactCallback = null;
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.title = "Record Compare";
    this.errorMessages = [];
    this.warnings = [];

    this.inputs = {a: id1 || "", b: id2 || ""};
    this.running = false;
    this.result = null;   // {object, objectLabel, summaries: {a, b}, rows}
    this.onlyDiff = true;
    this.hideSystem = true;
    this.search = "";
    this.expanded = new Set();
    this.globalDescribe = null;

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

  async objectForId(id) {
    if (!this.globalDescribe) {
      this.globalDescribe = await sfConn.rest("/services/data/v" + apiVersion + "/sobjects/");
    }
    const prefix = id.substring(0, 3);
    return (this.globalDescribe.sobjects || []).find(s => s.keyPrefix === prefix) || null;
  }

  recordUrl(id) {
    return this.sfLink + "/" + id;
  }

  async fetchRecord(objName, id, slot) {
    try {
      return await sfConn.rest("/services/data/v" + apiVersion + "/sobjects/" + encodeURIComponent(objName) + "/" + encodeURIComponent(id));
    } catch (err) {
      throw new Error("Record " + slot + " (" + id + ") not found, or you don't have access to it. " + err.message);
    }
  }

  /** Resolves lookup names for both records. Falls back to fewer lookups, then to none. */
  async loadLookupNames(objName, fields, recA, recB) {
    const lookups = fields
      .filter(f => f.type === "reference" && (recA[f.name] || recB[f.name]))
      .map(f => ({f, info: lookupNameField(f)}))
      .filter(x => x.info)
      .map(x => ({f: x.f, nf: x.info.nf, assumed: x.info.assumed}));
    const names = {a: {}, b: {}};
    if (lookups.length === 0) return names;
    const attempt = async (list) => {
      const select = ["Id"].concat(list.map(x => x.f.relationshipName + "." + x.nf));
      const soql = "SELECT " + select.join(", ") + " FROM " + objName
        + " WHERE Id IN ('" + soqlString(recA.Id) + "', '" + soqlString(recB.Id) + "')";
      const res = await sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
      for (const rec of res.records || []) {
        const slot = sameId(rec.Id, recA.Id) ? "a" : "b";
        for (const x of list) {
          const related = rec[x.f.relationshipName];
          if (related && related[x.nf] != null) names[slot][x.f.name] = String(related[x.nf]);
        }
      }
    };
    try {
      await attempt(lookups);
    } catch (err) {
      console.error(err);
      const safe = lookups.filter(x => !x.assumed);
      try {
        if (safe.length) await attempt(safe);
      } catch (err2) {
        console.error(err2);
      }
      this.warnings.push("Some lookup names could not be resolved; their Ids are shown instead.");
    }
    return names;
  }

  summary(rec, names, fields, nameField) {
    const has = n => fields.some(f => f.name === n);
    return {
      id: rec.Id,
      name: nameField ? rec[nameField.name] : rec.Id,
      recordType: has("RecordTypeId") && rec.RecordTypeId ? (names.RecordTypeId || rec.RecordTypeId) : null,
      owner: has("OwnerId") && rec.OwnerId ? (names.OwnerId || rec.OwnerId) : null,
      ownerId: rec.OwnerId || null,
      modifiedDate: rec.LastModifiedDate || null,
      modifiedBy: has("LastModifiedById") && rec.LastModifiedById ? (names.LastModifiedById || rec.LastModifiedById) : null,
    };
  }

  async compare() {
    if (this.running) return;
    const a = this.inputs.a.trim();
    const b = this.inputs.b.trim();
    this.errorMessages = [];
    this.warnings = [];
    if (!RECORD_ID_RE.test(a) || !RECORD_ID_RE.test(b)) {
      this.errorMessages.push("Enter two record Ids (15 or 18 characters).");
      this.didUpdate();
      return;
    }
    if (sameId(a, b)) {
      this.errorMessages.push("Enter two different records.");
      this.didUpdate();
      return;
    }
    if (a.substring(0, 3) !== b.substring(0, 3)) {
      this.errorMessages.push("Both records must be of the same object.");
      this.didUpdate();
      return;
    }
    this.running = true;
    this.result = null;
    this.expanded = new Set();
    this.spinnerCount++;
    this.didUpdate();
    try {
      const sobject = await this.objectForId(a);
      if (!sobject) throw new Error("No object found for the Id prefix " + a.substring(0, 3) + ".");
      const describe = await sfConn.rest("/services/data/v" + apiVersion + "/sobjects/" + encodeURIComponent(sobject.name) + "/describe");
      const [recA, recB] = await Promise.all([
        this.fetchRecord(describe.name, a, "A"),
        this.fetchRecord(describe.name, b, "B"),
      ]);
      const fields = describe.fields || [];
      const names = await this.loadLookupNames(describe.name, fields, recA, recB);
      const nameField = fields.find(f => f.nameField);
      this.result = {
        object: describe.name,
        objectLabel: describe.label,
        summaries: {
          a: this.summary(recA, names.a, fields, nameField),
          b: this.summary(recB, names.b, fields, nameField),
        },
        rows: buildRows(fields, recA, recB, names),
      };
    } catch (err) {
      console.error(err);
      this.errorMessages.push(err.message);
    } finally {
      this.running = false;
      this.spinnerCount--;
      this.didUpdate();
    }
  }

  visibleRows() {
    if (!this.result) return [];
    return filterRows(this.result.rows, {onlyDiff: this.onlyDiff, hideSystem: this.hideSystem, search: this.search});
  }

  downloadCsv() {
    const header = ["Field", "API Name", "Record A", "Record B", "Different"].join(",");
    const body = this.visibleRows().map(r =>
      [r.label, r.api, r.a.text, r.b.text, r.diff ? "Yes" : "No"].map(csvCell).join(",")).join("\n");
    downloadCsvFile(header + "\n" + body, "record-compare-" + this.result.summaries.a.id + "-" + this.result.summaries.b.id + ".csv");
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onCompare = this.onCompare.bind(this);
    this.onCsv = this.onCsv.bind(this);
  }

  onKeyDown(e) { if (e.key === "Enter") { e.preventDefault(); this.onCompare(); } }
  onCompare() { this.props.vm.compare(); }
  onCsv() { this.props.vm.downloadCsv(); }
  setInput(key, value) { this.props.vm.inputs[key] = value; this.props.vm.didUpdate(); }
  setOption(key, value) { this.props.vm[key] = value; this.props.vm.didUpdate(); }
  toggleExpand(key) {
    const model = this.props.vm;
    if (model.expanded.has(key)) model.expanded.delete(key); else model.expanded.add(key);
    model.didUpdate();
  }

  renderInput(key, label) {
    const model = this.props.vm;
    return h("div", {className: "slds-form-element rc-input"},
      h("label", {className: "slds-form-element__label"}, label),
      h("div", {className: "slds-form-element__control"},
        h("input", {
          type: "search",
          className: "slds-input",
          placeholder: "006Tp00000aRf0mIAC",
          value: model.inputs[key],
          onChange: e => this.setInput(key, e.target.value),
          onKeyDown: this.onKeyDown,
        })
      )
    );
  }

  renderSummary(slot) {
    const model = this.props.vm;
    const s = model.result.summaries[slot];
    return h("div", {className: "rc-summary"},
      h("div", {className: "rc-slot"}, "Record " + slot.toUpperCase()),
      h("div", {className: "slds-text-heading_small"},
        h("a", {href: model.recordUrl(s.id), target: "_blank", title: "Open record"}, s.name || s.id)),
      h("dl", {className: "rc-meta"},
        h("dt", {}, "Id"), h("dd", {}, s.id),
        s.recordType && h("dt", {}, "Record Type"), s.recordType && h("dd", {}, s.recordType),
        s.owner && h("dt", {}, "Owner"), s.owner && h("dd", {}, s.owner),
        s.modifiedDate && h("dt", {}, "Last modified"),
        s.modifiedDate && h("dd", {}, formatDateTime(s.modifiedDate) + (s.modifiedBy ? " by " + s.modifiedBy : ""))
      )
    );
  }

  renderCell(row, slot) {
    const model = this.props.vm;
    const v = row[slot];
    if (v.text == null) return h("span", {className: "rc-muted"}, "(empty)");
    if (v.id) {
      return h("span", {},
        h("a", {href: model.recordUrl(v.id), target: "_blank", title: v.id}, v.text),
        v.text !== v.id && h("div", {className: "rc-api"}, v.id));
    }
    const key = row.api + "|" + slot;
    if (v.text.length > TRUNCATE_AT) {
      const open = model.expanded.has(key);
      return h("span", {className: "rc-value"},
        open ? v.text : v.text.substring(0, TRUNCATE_AT) + "…",
        " ",
        h("button", {className: "slds-button rc-more", onClick: () => this.toggleExpand(key)}, open ? "Show less" : "Show more"));
    }
    return h("span", {className: "rc-value"}, v.text);
  }

  renderResult() {
    const model = this.props.vm;
    const res = model.result;
    const rows = model.visibleRows();
    const diffCount = res.rows.filter(r => r.diff && (!model.hideSystem || !r.system)).length;
    return h("div", {},
      h("div", {className: "rc-summaries"}, this.renderSummary("a"), this.renderSummary("b")),
      h("div", {className: "rc-filters"},
        h("label", {className: "rc-check"},
          h("input", {type: "checkbox", checked: model.onlyDiff, onChange: e => this.setOption("onlyDiff", e.target.checked)}),
          " Only differences"),
        h("label", {className: "rc-check"},
          h("input", {type: "checkbox", checked: model.hideSystem, onChange: e => this.setOption("hideSystem", e.target.checked)}),
          " Hide system fields"),
        h("input", {type: "search", className: "slds-input rc-search", placeholder: "Filter by field", value: model.search, onChange: e => this.setOption("search", e.target.value)}),
        h("span", {className: "rc-grow slds-text-body_small slds-text-color_weak"},
          res.objectLabel + " · " + diffCount + " difference(s) · " + rows.length + " row(s) shown"),
        h("button", {className: "slds-button slds-button_neutral", disabled: rows.length === 0, onClick: this.onCsv, title: "Download the visible rows as CSV"}, "Download CSV")
      ),
      rows.length > 0
        ? h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered rc-table"},
          h("thead", {},
            h("tr", {className: "slds-line-height_reset"},
              h("th", {style: {width: "28%"}}, "Field"),
              h("th", {style: {width: "36%"}}, "Record A"),
              h("th", {style: {width: "36%"}}, "Record B")
            )
          ),
          h("tbody", {},
            rows.map(r =>
              h("tr", {key: r.api, className: r.diff ? "rc-diff" : ""},
                h("td", {}, r.label, h("div", {className: "rc-api"}, r.api)),
                h("td", {}, this.renderCell(r, "a")),
                h("td", {}, this.renderCell(r, "b"))
              )
            )
          )
        )
        : h("div", {className: "rc-empty"}, model.onlyDiff && !model.search ? "No differences." : "No fields match the filters.")
    );
  }

  render() {
    const model = this.props.vm;
    document.title = model.title;
    return h("div", {},
      h(PageHeader, {
        pageTitle: "Record Compare",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        ...model.userInfoModel.getProps()
      }),
      h("div", {className: "slds-m-top_xx-large sfir-page-container"},
        h("div", {className: "slds-card slds-m-around_medium", style: {flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0}},
          h("div", {className: "slds-card__header slds-p-horizontal_small slds-p-top_small"},
            h("div", {className: "rc-inputs"},
              this.renderInput("a", "Record A Id"),
              this.renderInput("b", "Record B Id"),
              h("button", {className: "slds-button slds-button_brand", disabled: model.running, onClick: this.onCompare}, model.running ? "Comparing…" : "Compare")
            )
          ),
          h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1", overflowY: "auto", minHeight: 0}},
            model.errorMessages.length > 0
              && h("div", {className: "slds-notify slds-notify_alert slds-theme_error slds-m-bottom_small", role: "alert"},
                model.errorMessages[model.errorMessages.length - 1]),
            model.warnings.map((w, i) =>
              h("div", {key: "w" + i, className: "slds-notify slds-notify_alert slds-theme_warning slds-m-bottom_x-small", role: "alert"}, w)),
            model.result
              ? this.renderResult()
              : !model.running && h("div", {className: "rc-empty"}, "Enter two record Ids of the same object and press Compare to see their fields side by side.")
          )
        )
      )
    );
  }
}

{
  let args = new URLSearchParams(location.search.slice(1));
  let sfHost = args.get("host");
  let id1 = args.get("id1") || "";
  let id2 = args.get("id2") || "";
  initButton(sfHost, true);
  sfConn.getSession(sfHost).then(() => {
    let root = document.getElementById("root");
    let vm = new Model(sfHost, id1, id2);
    vm.reactCallback = cb => {
      ReactDOM.render(h(App, {vm}), root, cb);
    };
    ReactDOM.render(h(App, {vm}), root);
    if (RECORD_ID_RE.test(id1) && RECORD_ID_RE.test(id2)) vm.compare();
  });
}
