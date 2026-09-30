/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {PageHeader} from "./components/PageHeader.js";
import {UserInfoModel, downloadCsvFile} from "./utils.js";
/* global initButton */

let h = React.createElement;

const RECORD_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

const SPECIAL_FIELDS = {
  created: "Record created",
  locked: "Record locked",
  unlocked: "Record unlocked",
  ownerAssignment: "Owner assigned",
  ownerAccepted: "Owner accepted",
  ownerEscalated: "Escalated",
  feedEvent: "Feed event",
};

const LONG_TEXT_TYPES = ["textarea"];

function soqlString(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
}

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function isIdLike(v) {
  return typeof v === "string" && RECORD_ID_RE.test(v);
}

/** Finds the field history child relationship of an object describe: {object, field} or null. */
export function findHistoryRelation(describe) {
  const rels = describe.childRelationships || [];
  const byName = rels.find(r => r.relationshipName === "Histories" && r.childSObject);
  if (byName) return {object: byName.childSObject, field: byName.field};
  const name = describe.name;
  const candidates = [name + "FieldHistory", name + "History"];
  if (name.endsWith("__c")) candidates.push(name.slice(0, -3) + "__History");
  for (const c of candidates) {
    if (c === "OpportunityHistory") continue;
    const rel = rels.find(r => r.childSObject === c);
    if (rel) return {object: rel.childSObject, field: rel.field};
  }
  return null;
}

/** Index of describe fields by API name, by name without "Id" and by relationship name (history uses e.g. "Owner", "Account"). */
export function buildFieldIndex(fields) {
  const index = new Map();
  const add = (key, f) => { if (key && !index.has(key.toLowerCase())) index.set(key.toLowerCase(), f); };
  for (const f of fields || []) add(f.name, f);
  for (const f of fields || []) {
    if (f.type === "reference") {
      add(f.relationshipName, f);
      if (/Id$/.test(f.name)) add(f.name.slice(0, -2), f);
    }
  }
  return index;
}

export function formatValue(v, fieldDesc) {
  if (v === null || v === undefined || v === "") return null;
  const type = fieldDesc && fieldDesc.type;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (type === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const [y, m, d] = v.substring(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString();
  }
  if (type === "datetime" && typeof v === "string") return formatDateTime(v);
  return String(v);
}

/** Lookup labels come as "Owner ID" in the describe; "Owner" reads better. */
export function lookupLabel(f) {
  return f.type === "reference" && / ID$/.test(f.label) ? f.label.slice(0, -3) : f.label;
}

function isIdRow(r) {
  if (r.dataType) return r.dataType === "EntityId";
  return (r.old == null || isIdLike(r.old)) && (r.new == null || isIdLike(r.new)) && (r.old != null || r.new != null);
}

/**
 * Turns raw history records (newest first) into saves: [{key, date, userId, user, changes: [...]}].
 * Lookup changes are stored by Salesforce as two rows (Id and name); they are merged into one change.
 */
export function processHistory(records, fieldIndex) {
  const rows = records.map((r, i) => ({
    seq: i,
    field: r.Field || "",
    dataType: r.DataType || "",
    old: r.OldValue,
    new: r.NewValue,
    date: r.CreatedDate,
    userId: r.CreatedById || "",
    user: (r.CreatedBy && r.CreatedBy.Name) || "",
  }));

  const buckets = new Map();
  for (const r of rows) {
    const key = r.date + "|" + r.userId + "|" + r.field;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const dropped = new Set();
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const idRows = list.filter(isIdRow);
    const textRows = list.filter(r => !isIdRow(r));
    if (idRows.length === 0 || idRows.length !== textRows.length) continue;
    textRows.forEach((t, i) => {
      t.oldId = isIdLike(idRows[i].old) ? idRows[i].old : null;
      t.newId = isIdLike(idRows[i].new) ? idRows[i].new : null;
      dropped.add(idRows[i].seq);
    });
  }

  const saves = [];
  const saveByKey = new Map();
  for (const r of rows) {
    if (dropped.has(r.seq)) continue;
    const saveKey = r.date + "|" + r.userId;
    let save = saveByKey.get(saveKey);
    if (!save) {
      save = {key: saveKey, date: r.date, userId: r.userId, user: r.user, changes: []};
      saveByKey.set(saveKey, save);
      saves.push(save);
    }
    const special = SPECIAL_FIELDS[r.field];
    const desc = special ? null : fieldIndex.get(r.field.toLowerCase());
    const change = {
      fieldKey: r.field,
      label: special || (desc ? lookupLabel(desc) : r.field),
      api: special ? "" : (desc ? desc.name : r.field),
      special: !!special,
      oldText: special ? null : formatValue(r.old, desc),
      newText: special ? null : formatValue(r.new, desc),
      oldId: r.oldId || (isIdLike(r.old) && isIdRow(r) ? r.old : null),
      newId: r.newId || (isIdLike(r.new) && isIdRow(r) ? r.new : null),
      notStored: false,
    };
    if (!special && r.old == null && r.new == null && (!desc || LONG_TEXT_TYPES.includes(desc.type))) {
      change.notStored = true;
    }
    save.changes.push(change);
  }
  return saves;
}

/** Filters saves by field key and user id; saves left without changes are removed. */
export function filterSaves(saves, fieldKey, userId) {
  const out = [];
  for (const s of saves) {
    if (userId && s.userId !== userId) continue;
    const changes = fieldKey ? s.changes.filter(c => c.fieldKey === fieldKey) : s.changes;
    if (changes.length) out.push(Object.assign({}, s, {changes}));
  }
  return out;
}

class Model {
  constructor(sfHost, recordId) {
    this.reactCallback = null;
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.title = "Record History";
    this.errorMessages = [];
    this.warnings = [];

    this.input = recordId || "";
    this.running = false;
    this.result = null;        // {object, objectLabel, historyObject, record, trackedFields, saves}
    this.showTracked = false;
    this.fieldFilter = "";
    this.userFilter = "";
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

  describe(objName) {
    return sfConn.rest("/services/data/v" + apiVersion + "/sobjects/" + encodeURIComponent(objName) + "/describe");
  }

  async objectForId(id) {
    if (!this.globalDescribe) {
      this.globalDescribe = await sfConn.rest("/services/data/v" + apiVersion + "/sobjects/");
    }
    const prefix = id.substring(0, 3);
    return (this.globalDescribe.sobjects || []).find(s => s.keyPrefix === prefix) || null;
  }

  userSetupUrl(userId) {
    return this.sfLink + "/lightning/setup/ManageUsers/page?address=%2F" + userId + "%3Fnoredirect%3D1%26isUserEntityOverride%3D1";
  }

  recordUrl(id) {
    return this.sfLink + "/" + id;
  }

  async run() {
    if (this.running) return;
    const id = this.input.trim();
    this.errorMessages = [];
    this.warnings = [];
    if (!RECORD_ID_RE.test(id)) {
      this.errorMessages.push("Enter a record Id (15 or 18 characters).");
      this.didUpdate();
      return;
    }
    this.running = true;
    this.result = null;
    this.fieldFilter = "";
    this.userFilter = "";
    this.showTracked = false;
    this.spinnerCount++;
    this.didUpdate();
    try {
      const sobject = await this.objectForId(id);
      if (!sobject) throw new Error("No object found for the Id prefix " + id.substring(0, 3) + ".");
      const describe = await this.describe(sobject.name);
      const rel = findHistoryRelation(describe);
      const fields = describe.fields || [];
      const fieldNames = new Set(fields.map(f => f.name));
      const nameField = fields.find(f => f.nameField);

      const select = ["Id"];
      if (nameField && nameField.name !== "Id") select.push(nameField.name);
      if (fieldNames.has("RecordTypeId")) select.push("RecordType.Name");
      if (fieldNames.has("CreatedDate")) select.push("CreatedDate");
      if (fieldNames.has("CreatedById")) select.push("CreatedById", "CreatedBy.Name");
      const recs = await this.queryAll("SELECT " + select.join(", ") + " FROM " + describe.name + " WHERE Id = '" + soqlString(id) + "'");
      if (recs.length === 0) throw new Error("Record not found, or you don't have access to it.");
      const r = recs[0];
      const record = {
        id: r.Id,
        name: nameField ? r[nameField.name] : r.Id,
        recordType: r.RecordType ? r.RecordType.Name : null,
        createdDate: r.CreatedDate || null,
        createdById: r.CreatedById || null,
        createdBy: r.CreatedBy ? r.CreatedBy.Name : null,
      };

      const result = {
        object: describe.name,
        objectLabel: describe.label,
        historyObject: rel ? rel.object : null,
        record,
        trackedFields: null,
        saves: [],
      };

      if (rel) {
        const [tracked, saves] = await Promise.all([
          this.loadTrackedFields(describe.name),
          this.loadSaves(rel, id, fields),
        ]);
        result.trackedFields = tracked;
        result.saves = saves;
        if (record.createdDate && !saves.some(s => s.changes.some(c => c.fieldKey === "created"))) {
          saves.push({
            key: "synthetic-created",
            date: record.createdDate,
            userId: record.createdById || "",
            user: record.createdBy || "",
            synthetic: true,
            changes: [{fieldKey: "created", label: SPECIAL_FIELDS.created, api: "", special: true, oldText: null, newText: null, oldId: null, newId: null, notStored: false}],
          });
        }
      }
      this.result = result;
    } catch (err) {
      console.error(err);
      this.errorMessages.push(err.message);
    } finally {
      this.running = false;
      this.spinnerCount--;
      this.didUpdate();
    }
  }

  async loadTrackedFields(objName) {
    try {
      const recs = await this.queryAll("SELECT QualifiedApiName, Label, IsFieldHistoryTracked FROM FieldDefinition"
        + " WHERE EntityDefinition.QualifiedApiName = '" + soqlString(objName) + "'");
      return recs.filter(f => f.IsFieldHistoryTracked)
        .map(f => ({api: f.QualifiedApiName, label: f.Label}))
        .sort((a, b) => a.label.localeCompare(b.label));
    } catch (err) {
      console.error(err);
      this.warnings.push("Could not load the list of tracked fields: " + err.message);
      return null;
    }
  }

  async loadSaves(rel, id, fields) {
    const histDescribe = await this.describe(rel.object);
    const histFields = new Set((histDescribe.fields || []).map(f => f.name));
    const select = ["Id", "Field", "OldValue", "NewValue", "CreatedDate", "CreatedById", "CreatedBy.Name"];
    if (histFields.has("DataType")) select.push("DataType");
    const records = await this.queryAll("SELECT " + select.join(", ") + " FROM " + rel.object
      + " WHERE " + rel.field + " = '" + soqlString(id) + "' ORDER BY CreatedDate DESC, Id DESC");
    return processHistory(records, buildFieldIndex(fields));
  }

  fieldOptions() {
    if (!this.result) return [];
    const seen = new Map();
    for (const s of this.result.saves) {
      for (const c of s.changes) {
        if (!seen.has(c.fieldKey)) seen.set(c.fieldKey, c.label);
      }
    }
    return Array.from(seen, ([key, label]) => ({key, label})).sort((a, b) => a.label.localeCompare(b.label));
  }

  userOptions() {
    if (!this.result) return [];
    const seen = new Map();
    for (const s of this.result.saves) {
      if (s.userId && !seen.has(s.userId)) seen.set(s.userId, s.user || s.userId);
    }
    return Array.from(seen, ([id, name]) => ({id, name})).sort((a, b) => a.name.localeCompare(b.name));
  }

  visibleSaves() {
    if (!this.result) return [];
    return filterSaves(this.result.saves, this.fieldFilter, this.userFilter);
  }

  downloadCsv() {
    const header = ["Date", "User", "Field", "Field API Name", "Old Value", "New Value"].join(",");
    const lines = [];
    for (const s of this.visibleSaves()) {
      for (const c of s.changes) {
        lines.push([formatDateTime(s.date), s.user, c.label, c.api,
          c.oldText != null ? c.oldText : (c.oldId || ""), c.newText != null ? c.newText : (c.newId || "")].map(csvCell).join(","));
      }
    }
    downloadCsvFile(header + "\n" + lines.join("\n"), "record-history-" + this.result.record.id + ".csv");
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.onInput = this.onInput.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onRun = this.onRun.bind(this);
    this.onToggleTracked = this.onToggleTracked.bind(this);
    this.onCsv = this.onCsv.bind(this);
  }

  onInput(e) { this.props.vm.input = e.target.value; this.props.vm.didUpdate(); }
  onKeyDown(e) { if (e.key === "Enter") { e.preventDefault(); this.onRun(); } }
  onRun() { this.props.vm.run(); }
  onToggleTracked() { this.props.vm.showTracked = !this.props.vm.showTracked; this.props.vm.didUpdate(); }
  onCsv() { this.props.vm.downloadCsv(); }
  setFilter(key, value) { this.props.vm[key] = value; this.props.vm.didUpdate(); }

  renderValue(text, id, change) {
    const model = this.props.vm;
    if (change.special) return null;
    if (change.notStored) return h("span", {className: "rh-muted"}, "Not stored");
    if (text == null && !id) return h("span", {className: "rh-muted"}, "(empty)");
    if (id) return h("a", {href: model.recordUrl(id), target: "_blank", title: id}, text != null ? text : id);
    return h("span", {className: "rh-value"}, text);
  }

  renderRecordCard() {
    const model = this.props.vm;
    const res = model.result;
    const rec = res.record;
    return h("div", {className: "rh-record"},
      h("div", {className: "slds-text-heading_small"},
        h("a", {href: model.recordUrl(rec.id), target: "_blank", title: "Open record"}, rec.name || rec.id)),
      h("div", {className: "rh-sub"},
        res.objectLabel + " (" + res.object + ")"
        + (rec.recordType ? " · Record Type: " + rec.recordType : "")
        + (rec.createdDate ? " · Created " + formatDateTime(rec.createdDate) + (rec.createdBy ? " by " + rec.createdBy : "") : "")),
      res.historyObject && h("div", {className: "rh-sub"}, "History object: " + res.historyObject)
    );
  }

  renderTracked() {
    const model = this.props.vm;
    const tracked = model.result.trackedFields;
    if (tracked === null) return null;
    return h("div", {className: "rh-tracked"},
      h("button", {className: "slds-button rh-toggle", onClick: this.onToggleTracked},
        (model.showTracked ? "▾ " : "▸ ") + "Tracked fields (" + tracked.length + ")"),
      model.showTracked && (tracked.length === 0
        ? h("div", {className: "rh-muted rh-tracked-list"}, "No field of this object has history tracking enabled.")
        : h("div", {className: "rh-tracked-list"},
          tracked.map(f => h("span", {key: f.api, className: "rh-chip", title: f.api}, f.label))))
    );
  }

  renderTimeline(saves) {
    const model = this.props.vm;
    return h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered rh-table"},
      h("thead", {},
        h("tr", {className: "slds-line-height_reset"},
          h("th", {style: {width: "30%"}}, "Field"),
          h("th", {style: {width: "35%"}}, "Old value"),
          h("th", {style: {width: "35%"}}, "New value")
        )
      ),
      saves.map(s =>
        h("tbody", {key: s.key},
          h("tr", {className: "rh-save"},
            h("td", {colSpan: 3},
              h("strong", {}, formatDateTime(s.date)),
              " · ",
              s.userId ? h("a", {href: model.userSetupUrl(s.userId), target: "_blank", title: "Open user in Setup"}, s.user || s.userId) : (s.user || "Unknown user"),
              s.changes.length > 1 && h("span", {className: "rh-count"}, s.changes.length + " fields in the same save"),
              s.synthetic && h("span", {className: "rh-count"}, "from the record, not from history")
            )
          ),
          s.changes.map((c, i) =>
            h("tr", {key: i},
              c.special
                ? h("td", {colSpan: 3}, h("span", {className: "slds-badge rh-badge-event"}, c.label))
                : h("td", {}, c.label, c.api && c.api !== c.label && h("div", {className: "rh-api"}, c.api)),
              !c.special && h("td", {}, this.renderValue(c.oldText, c.oldId, c)),
              !c.special && h("td", {}, this.renderValue(c.newText, c.newId, c))
            )
          )
        )
      )
    );
  }

  renderResult() {
    const model = this.props.vm;
    const res = model.result;
    if (!res.historyObject) {
      return h("div", {},
        this.renderRecordCard(),
        h("div", {className: "slds-notify slds-notify_alert slds-theme_warning slds-m-top_small", role: "alert"},
          "Field history tracking is not enabled for " + res.objectLabel + "."));
    }
    const saves = model.visibleSaves();
    const changeCount = saves.reduce((n, s) => n + s.changes.length, 0);
    const fieldOptions = model.fieldOptions();
    const userOptions = model.userOptions();
    return h("div", {},
      this.renderRecordCard(),
      this.renderTracked(),
      h("p", {className: "rh-note"}, "Salesforce keeps field history for 18 months. Only fields with history tracking enabled appear here."),
      h("div", {className: "rh-filters"},
        h("div", {className: "slds-select_container"},
          h("select", {className: "slds-select", value: model.fieldFilter, onChange: e => this.setFilter("fieldFilter", e.target.value)},
            h("option", {value: ""}, "All fields"),
            fieldOptions.map(o => h("option", {key: o.key, value: o.key}, o.label)))),
        h("div", {className: "slds-select_container"},
          h("select", {className: "slds-select", value: model.userFilter, onChange: e => this.setFilter("userFilter", e.target.value)},
            h("option", {value: ""}, "All users"),
            userOptions.map(o => h("option", {key: o.id, value: o.id}, o.name)))),
        h("span", {className: "rh-grow slds-text-body_small slds-text-color_weak"},
          changeCount + " change(s) in " + saves.length + " save(s)"),
        h("button", {className: "slds-button slds-button_neutral", disabled: changeCount === 0, onClick: this.onCsv, title: "Download the visible changes as CSV"}, "Download CSV")
      ),
      saves.length > 0
        ? this.renderTimeline(saves)
        : h("div", {className: "rh-empty"}, res.saves.length === 0 ? "No history for this record." : "No changes match the filters.")
    );
  }

  render() {
    const model = this.props.vm;
    document.title = model.title;
    return h("div", {},
      h(PageHeader, {
        pageTitle: "Record History",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        ...model.userInfoModel.getProps()
      }),
      h("div", {className: "slds-m-top_xx-large sfir-page-container"},
        h("div", {className: "slds-card slds-m-around_medium", style: {flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0}},
          h("div", {className: "slds-card__header slds-p-horizontal_small slds-p-top_small"},
            h("div", {className: "slds-form-element"},
              h("label", {className: "slds-form-element__label"}, "Record Id"),
              h("div", {className: "slds-grid slds-grid_vertical-align-center"},
                h("div", {className: "slds-form-element__control slds-m-right_x-small", style: {flex: "1"}},
                  h("input", {
                    type: "search",
                    className: "slds-input",
                    placeholder: "006Tp00000aRf0mIAC",
                    value: model.input,
                    autoFocus: !model.input,
                    onChange: this.onInput,
                    onKeyDown: this.onKeyDown,
                  })
                ),
                h("button", {className: "slds-button slds-button_brand", disabled: model.running, onClick: this.onRun}, model.running ? "Loading…" : "Show history")
              )
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
              : !model.running && h("div", {className: "rh-empty"}, "Enter a record Id and press Show history to see who changed which fields and when.")
          )
        )
      )
    );
  }
}

{
  let args = new URLSearchParams(location.search.slice(1));
  let sfHost = args.get("host");
  let recordId = args.get("recordId") || "";
  initButton(sfHost, true);
  sfConn.getSession(sfHost).then(() => {
    let root = document.getElementById("root");
    let vm = new Model(sfHost, recordId);
    vm.reactCallback = cb => {
      ReactDOM.render(h(App, {vm}), root, cb);
    };
    ReactDOM.render(h(App, {vm}), root);
    if (RECORD_ID_RE.test(recordId)) vm.run();
  });
}
