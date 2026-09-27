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
    this.state = {input: "", open: false, activeIndex: 0, copied: false, metaOpen: false};
    // Callback refs (React 15 has no createRef)
    this.inputEl = null;
    this.findEl = null;
    this.dropdownEl = null;
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
  }

  componentDidUpdate() {
    const model = this.props.vm;
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && model.selected && !model.selected.hidden) {
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
            h("div", {className: "slds-grid slds-grid_vertical-align-end", style: {gap: ".5rem"}},
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
          h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1", display: "flex", flexDirection: "column", overflowY: "auto", minHeight: 0}},
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
    vm.reactCallback = cb => {
      ReactDOM.render(h(App, {vm}), root, cb);
    };
    ReactDOM.render(h(App, {vm}), root);
  });
}
