/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {PageHeader} from "./components/PageHeader.js";
import {UserInfoModel, downloadCsvFile} from "./utils.js";
/* global initButton */

let h = React.createElement;

const RANGES = [
  {value: "today", label: "Today"},
  {value: "7", label: "Last 7 days"},
  {value: "30", label: "Last 30 days"},
  {value: "180", label: "Last 180 days"},
  {value: "custom", label: "Custom"},
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function soqlDateTime(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function localMidnight(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
}

function fold(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleString();
}

/** Returns {start, end} Date objects for the selected range, or throws with a user-facing message. */
export function computeRange(range, from, to, now = new Date()) {
  if (range === "today") {
    return {start: new Date(now.getFullYear(), now.getMonth(), now.getDate()), end: null};
  }
  if (range === "custom") {
    if (!DATE_RE.test(from || "")) throw new Error("Enter the start date.");
    const start = localMidnight(from);
    let end = null;
    if (to) {
      if (!DATE_RE.test(to)) throw new Error("The end date is not valid.");
      end = localMidnight(to);
      end.setDate(end.getDate() + 1);
      if (end <= start) throw new Error("The end date must be on or after the start date.");
    }
    return {start, end};
  }
  const days = Number(range);
  return {start: new Date(now.getTime() - days * 24 * 3600 * 1000), end: null};
}

/** Maps a SetupAuditTrail record to a display row. */
export function toRow(r) {
  return {
    id: r.Id,
    date: r.CreatedDate,
    section: r.Section || "",
    userId: r.CreatedById || "",
    user: (r.CreatedBy && r.CreatedBy.Name) || "",
    delegate: r.DelegateUser || "",
    action: r.Action || "",
    display: r.Display || "",
  };
}

export function filterRows(rows, {section, user, text}) {
  const u = fold(user).trim();
  const t = fold(text).trim();
  return rows.filter(r =>
    (!section || r.section === section)
    && (!u || fold(r.user).includes(u) || fold(r.delegate).includes(u))
    && (!t || fold(r.display).includes(t) || fold(r.action).includes(t)));
}

class Model {
  constructor(sfHost) {
    this.reactCallback = null;
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.title = "Setup Audit Trail";
    this.errorMessages = [];

    this.range = "7";
    this.from = "";
    this.to = "";
    this.filters = {section: "", user: "", text: ""};

    this.rows = [];
    this.sections = [];
    this.loaded = false;
    this.loading = false;
    this.loadToken = 0;

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

  userSetupUrl(userId) {
    return this.sfLink + "/lightning/setup/ManageUsers/page?address=%2F" + userId + "%3Fnoredirect%3D1%26isUserEntityOverride%3D1";
  }

  async load() {
    this.errorMessages = [];
    let range;
    try {
      range = computeRange(this.range, this.from, this.to);
    } catch (err) {
      this.errorMessages.push(err.message);
      this.didUpdate();
      return;
    }
    const token = ++this.loadToken;
    let soql = "SELECT Id, CreatedDate, CreatedById, CreatedBy.Name, Action, Section, Display, DelegateUser"
      + " FROM SetupAuditTrail WHERE CreatedDate >= " + soqlDateTime(range.start);
    if (range.end) soql += " AND CreatedDate < " + soqlDateTime(range.end);
    soql += " ORDER BY CreatedDate DESC";

    this.loading = true;
    this.spinnerCount++;
    this.didUpdate();
    try {
      const records = await this.queryAll(soql);
      if (token !== this.loadToken) return;
      this.rows = records.map(toRow);
      this.sections = Array.from(new Set(this.rows.map(r => r.section).filter(Boolean))).sort((a, b) => a.localeCompare(b));
      if (this.filters.section && !this.sections.includes(this.filters.section)) this.filters.section = "";
      this.loaded = true;
    } catch (err) {
      console.error(err);
      if (token === this.loadToken) this.errorMessages.push("Error loading the audit trail: " + err.message);
    } finally {
      this.spinnerCount--;
      if (token === this.loadToken) this.loading = false;
      this.didUpdate();
    }
  }

  filteredRows() {
    return filterRows(this.rows, this.filters);
  }

  downloadCsv() {
    const header = ["Date", "Section", "User", "Delegate User", "Action", "Change"].join(",");
    const body = this.filteredRows().map(r =>
      [formatDate(r.date), r.section, r.user, r.delegate, r.action, r.display].map(csvCell).join(",")).join("\n");
    downloadCsvFile(header + "\n" + body, "setup-audit-trail-" + this.orgName.toLowerCase() + ".csv");
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.onRange = this.onRange.bind(this);
    this.onLoad = this.onLoad.bind(this);
    this.onCsv = this.onCsv.bind(this);
  }

  onRange(e) {
    const model = this.props.vm;
    model.range = e.target.value;
    if (model.range === "custom") {
      model.didUpdate();
    } else {
      model.load();
    }
  }
  onLoad() { this.props.vm.load(); }
  onCsv() { this.props.vm.downloadCsv(); }
  setFilter(key, value) { this.props.vm.filters[key] = value; this.props.vm.didUpdate(); }
  setDate(key, value) { this.props.vm[key] = value; this.props.vm.didUpdate(); }

  renderToolbar() {
    const model = this.props.vm;
    const isCustom = model.range === "custom";
    return h("div", {className: "sat-toolbar"},
      h("div", {className: "sat-row"},
        h("div", {className: "slds-form-element"},
          h("label", {className: "slds-form-element__label"}, "Period"),
          h("div", {className: "slds-form-element__control"},
            h("div", {className: "slds-select_container"},
              h("select", {className: "slds-select", value: model.range, onChange: this.onRange},
                RANGES.map(r => h("option", {key: r.value, value: r.value}, r.label)))))
        ),
        isCustom && h("div", {className: "slds-form-element"},
          h("label", {className: "slds-form-element__label"}, "From"),
          h("div", {className: "slds-form-element__control"},
            h("input", {type: "date", className: "slds-input", value: model.from, onChange: e => this.setDate("from", e.target.value)}))
        ),
        isCustom && h("div", {className: "slds-form-element"},
          h("label", {className: "slds-form-element__label"}, "To"),
          h("div", {className: "slds-form-element__control"},
            h("input", {type: "date", className: "slds-input", value: model.to, onChange: e => this.setDate("to", e.target.value)}))
        ),
        h("button", {className: "slds-button slds-button_brand", disabled: model.loading, onClick: this.onLoad},
          model.loading ? "Loading…" : (isCustom ? "Load" : "Refresh"))
      ),
      h("div", {className: "sat-row"},
        h("div", {className: "slds-form-element"},
          h("label", {className: "slds-form-element__label"}, "Section"),
          h("div", {className: "slds-form-element__control"},
            h("div", {className: "slds-select_container"},
              h("select", {className: "slds-select", value: model.filters.section, onChange: e => this.setFilter("section", e.target.value)},
                h("option", {value: ""}, "All sections"),
                model.sections.map(s => h("option", {key: s, value: s}, s)))))
        ),
        h("div", {className: "slds-form-element sat-grow"},
          h("label", {className: "slds-form-element__label"}, "User"),
          h("div", {className: "slds-form-element__control"},
            h("input", {type: "search", className: "slds-input", placeholder: "Name of the user", value: model.filters.user, onChange: e => this.setFilter("user", e.target.value)}))
        ),
        h("div", {className: "slds-form-element sat-grow"},
          h("label", {className: "slds-form-element__label"}, "Text in change"),
          h("div", {className: "slds-form-element__control"},
            h("input", {type: "search", className: "slds-input", placeholder: "ReservaDePlaza", value: model.filters.text, onChange: e => this.setFilter("text", e.target.value)}))
        )
      )
    );
  }

  render() {
    const model = this.props.vm;
    document.title = model.title;
    const rows = model.filteredRows();
    return h("div", {},
      h(PageHeader, {
        pageTitle: "Setup Audit Trail",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        ...model.userInfoModel.getProps()
      }),
      h("div", {className: "slds-m-top_xx-large sfir-page-container"},
        h("div", {className: "slds-card slds-m-around_medium", style: {flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0}},
          h("div", {className: "slds-card__header slds-p-horizontal_small slds-p-top_small"}, this.renderToolbar()),
          h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1", overflowY: "auto", minHeight: 0}},
            model.errorMessages.length > 0
              && h("div", {className: "slds-notify slds-notify_alert slds-theme_error slds-m-bottom_small", role: "alert"},
                model.errorMessages[model.errorMessages.length - 1]),
            model.loaded && h("div", {className: "sat-summary"},
              h("span", {className: "slds-text-body_small slds-text-color_weak"},
                rows.length === model.rows.length
                  ? model.rows.length + " change(s)"
                  : rows.length + " of " + model.rows.length + " change(s)"),
              h("button", {className: "slds-button slds-button_neutral", disabled: rows.length === 0, onClick: this.onCsv, title: "Download the visible rows as CSV"}, "Download CSV")
            ),
            model.loaded && rows.length > 0 && h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped sat-table"},
              h("thead", {},
                h("tr", {className: "slds-line-height_reset"},
                  h("th", {style: {width: "11rem"}}, "Date"),
                  h("th", {style: {width: "13rem"}}, "Section"),
                  h("th", {style: {width: "14rem"}}, "User"),
                  h("th", {}, "Change")
                )
              ),
              h("tbody", {},
                rows.map(r =>
                  h("tr", {key: r.id},
                    h("td", {className: "sat-nowrap"}, formatDate(r.date)),
                    h("td", {}, r.section),
                    h("td", {},
                      r.userId ? h("a", {href: model.userSetupUrl(r.userId), target: "_blank", title: "Open user in Setup"}, r.user || r.userId) : r.user,
                      r.delegate && h("div", {},
                        h("span", {className: "slds-badge sat-badge-delegate", title: r.delegate + " made this change while logged in as " + (r.user || "this user")}, "via " + r.delegate))
                    ),
                    h("td", {className: "sat-wrap"}, r.display)
                  )
                )
              )
            ),
            model.loaded && model.rows.length === 0 && !model.loading && model.errorMessages.length === 0
              && h("div", {className: "sat-empty"}, "No setup changes in this period."),
            model.loaded && model.rows.length > 0 && rows.length === 0
              && h("div", {className: "sat-empty"}, "No changes match the filters."),
            !model.loaded && !model.loading && model.range === "custom"
              && h("div", {className: "sat-empty"}, "Choose the dates and press Load."),
            h("p", {className: "sat-note"}, "Salesforce keeps the setup audit trail for 180 days.")
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
    vm.load();
  });
}
