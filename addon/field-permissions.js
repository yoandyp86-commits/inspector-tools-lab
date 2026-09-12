/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {PageHeader} from "./components/PageHeader.js";
import {UserInfoModel, copyToClipboard} from "./utils.js";
/* global initButton */

let h = React.createElement;

class Model {
  constructor(sfHost) {
    this.reactCallback = null;
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.title = "Field Permissions";
    this.errorMessages = [];

    this.selectedPS = null;   // {Id, Name, Label, Type}
    this.fields = [];         // rows
    this.filter = "";

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

  spinFor(actionName, promise, cb) {
    this.spinnerCount++;
    return promise
      .then(res => { this.spinnerCount--; cb(res); this.didUpdate(); })
      .catch(err => {
        console.error(err);
        this.errorMessages.push("Error " + actionName + ": " + err.message);
        this.spinnerCount--;
        this.didUpdate();
      });
  }

  async searchPermissionSets(query) {
    query = query.trim();
    if (!query) return [];
    const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    // IsOwnedByProfile = false hides the per-profile permission sets; show real PS and groups.
    const soql = "SELECT Id, Name, Label, Type, PermissionSetGroupId, License.Name FROM PermissionSet"
      + " WHERE IsOwnedByProfile = false AND (Label LIKE '%" + escaped + "%' OR Name LIKE '%" + escaped + "%')"
      + " WITH USER_MODE ORDER BY Label LIMIT 50";
    try {
      const res = await sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
      return res.records || [];
    } catch (err) {
      console.error("Unable to query permission sets:", err);
      this.errorMessages.push("Error searching permission sets: " + err.message);
      this.didUpdate();
      return [];
    }
  }

  selectPS(ps) {
    this.selectedPS = ps;
    this.fields = [];
    this.filter = "";
    this.didUpdate();
    this.loadFieldPermissions(ps.Id);
  }

  loadFieldPermissions(psId) {
    const soql = "SELECT Field, SobjectType, PermissionsRead, PermissionsEdit"
      + " FROM FieldPermissions WHERE ParentId = '" + psId + "'"
      + " ORDER BY SobjectType, PermissionsEdit DESC, Field";
    const promise = sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
    this.spinFor("loading field permissions", promise, (res) => {
      this.fields = (res.records || []).map(r => {
        // Field comes as "Object.FieldName"; strip the object prefix for display.
        const fieldName = r.Field.includes(".") ? r.Field.split(".").slice(1).join(".") : r.Field;
        return {
          object: r.SobjectType,
          field: fieldName,
          fullField: r.Field,
          read: !!r.PermissionsRead,
          edit: !!r.PermissionsEdit,
          access: r.PermissionsEdit ? "Read & Edit" : (r.PermissionsRead ? "Read" : "None"),
        };
      });
    });
  }

  filteredFields() {
    const f = this.filter.trim().toLowerCase();
    if (!f) return this.fields;
    return this.fields.filter(row =>
      row.field.toLowerCase().includes(f)
      || row.object.toLowerCase().includes(f));
  }

  copyAsCsv() {
    const rows = this.filteredFields();
    const header = "Object,Field,Access";
    const body = rows.map(r => r.object + "," + r.field + "," + r.access).join("\n");
    copyToClipboard(header + "\n" + body);
  }
}

function Mark({text, query}) {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return h("span", {},
    text.slice(0, i),
    h("mark", {}, text.slice(i, i + query.length)),
    text.slice(i + query.length));
}

class PSSearch extends React.Component {
  constructor(props) {
    super(props);
    this.state = {query: "", matches: [], open: false, activeIndex: -1};
    this.timer = null;
    this.onChange = this.onChange.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.wrapEl = null;
    this.setWrapEl = (el) => { this.wrapEl = el; };
    this.docClick = this.docClick.bind(this);
  }

  componentDidMount() { document.addEventListener("mousedown", this.docClick); }
  componentWillUnmount() {
    document.removeEventListener("mousedown", this.docClick);
    if (this.timer) clearTimeout(this.timer);
  }

  docClick(e) {
    if (this.wrapEl && !this.wrapEl.contains(e.target)) {
      this.setState({open: false});
    }
  }

  onChange(e) {
    const query = e.target.value;
    this.setState({query});
    if (this.timer) clearTimeout(this.timer);
    if (!query.trim()) { this.setState({matches: [], open: false}); return; }
    this.timer = setTimeout(async () => {
      const matches = await this.props.model.searchPermissionSets(query);
      this.setState({matches, open: true, activeIndex: -1});
    }, 350);
  }

  pick(ps) {
    this.setState({query: ps.Label, open: false});
    this.props.model.selectPS(ps);
  }

  onKeyDown(e) {
    const {matches, activeIndex, open} = this.state;
    if (!open || !matches.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); this.setState({activeIndex: Math.min(activeIndex + 1, matches.length - 1)}); }
    else if (e.key === "ArrowUp") { e.preventDefault(); this.setState({activeIndex: Math.max(activeIndex - 1, 0)}); }
    else if (e.key === "Enter" && activeIndex >= 0) { e.preventDefault(); this.pick(matches[activeIndex]); }
    else if (e.key === "Escape") { this.setState({open: false}); }
  }

  render() {
    const {query, matches, open, activeIndex} = this.state;
    return h("div", {className: "fp-search-wrapper", ref: this.setWrapEl},
      h("div", {className: "slds-form-element"},
        h("label", {className: "slds-form-element__label"}, "Search permission set"),
        h("div", {className: "slds-form-element__control slds-input-has-icon slds-input-has-icon_left"},
          h("svg", {className: "slds-icon slds-input__icon slds-input__icon_left slds-icon-text-default", viewBox: "0 0 520 520"},
            h("use", {xlinkHref: "symbols.svg#search"})),
          h("input", {
            type: "search",
            className: "slds-input",
            placeholder: "Permission set label or API name",
            value: query,
            autoFocus: true,
            onChange: this.onChange,
            onKeyDown: this.onKeyDown,
            onFocus: () => { if (matches.length) this.setState({open: true}); },
          })
        )
      ),
      open && matches.length > 0 && h("div", {className: "fp-dropdown"},
        matches.map((ps, idx) =>
          h("div", {
            key: ps.Id,
            className: "fp-dropdown-item" + (idx === activeIndex ? " fp-active" : ""),
            onMouseDown: (e) => { e.preventDefault(); this.pick(ps); },
          },
          h("div", {}, h(Mark, {text: ps.Label, query})),
          h("div", {className: "fp-sub"},
            h(Mark, {text: ps.Name, query}),
            ps.PermissionSetGroupId ? " · Group" : (ps.Type ? " · " + ps.Type : ""))
          )
        )
      ),
      open && matches.length === 0 && query.trim() &&
        h("div", {className: "fp-dropdown"}, h("div", {className: "fp-dropdown-item fp-sub"}, "No permission sets found"))
    );
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.model = this.props.vm;
    this.onCopy = this.onCopy.bind(this);
    this.onFilter = this.onFilter.bind(this);
  }

  onCopy() { this.model.copyAsCsv(); this.model.didUpdate(); }
  onFilter(e) { this.model.filter = e.target.value; this.model.didUpdate(); }

  render() {
    let model = this.props.vm;
    document.title = model.title;
    const ps = model.selectedPS;
    const rows = model.filteredFields();
    return h("div", {},
      h(PageHeader, {
        pageTitle: "Field Permissions",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        ...model.userInfoModel.getProps()
      }),
      h("div", {className: "slds-m-top_xx-large sfir-page-container"},
        h("div", {className: "slds-card slds-m-around_medium", style: {flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0}},
          h("div", {className: "slds-card__header slds-p-horizontal_small slds-p-top_small"},
            h(PSSearch, {model})
          ),
          h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1", overflowY: "auto", minHeight: 0}},
            model.errorMessages.length > 0 &&
              h("div", {className: "slds-notify slds-notify_alert slds-theme_error slds-m-bottom_small", role: "alert"},
                model.errorMessages[model.errorMessages.length - 1]),
            !ps && h("div", {className: "fp-empty"}, "Search and select a permission set to see the fields it grants access to."),
            ps && h("div", {className: "slds-m-bottom_small slds-grid slds-grid_vertical-align-center slds-wrap"},
              h("div", {className: "slds-col slds-size_1-of-2"},
                h("h2", {className: "slds-text-heading_small"}, ps.Label),
                h("p", {className: "slds-text-body_small slds-text-color_weak"},
                  ps.Name + " · " + model.fields.length + " field permission(s)")
              ),
              h("div", {className: "slds-col slds-size_1-of-2 slds-text-align_right slds-grid slds-grid_align-end slds-grid_vertical-align-center"},
                h("input", {
                  type: "search",
                  className: "slds-input fp-filter-input slds-m-right_x-small",
                  placeholder: "Filter by field or object",
                  value: model.filter,
                  onChange: this.onFilter,
                }),
                h("button", {
                  className: "slds-button slds-button_neutral",
                  disabled: rows.length === 0,
                  onClick: this.onCopy,
                  title: "Copy visible rows as CSV",
                }, "Copy CSV")
              )
            ),
            ps && rows.length > 0 && h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped"},
              h("thead", {},
                h("tr", {className: "slds-line-height_reset"},
                  h("th", {}, "Object"),
                  h("th", {}, "Field"),
                  h("th", {}, "Access")
                )
              ),
              h("tbody", {},
                rows.map(row =>
                  h("tr", {key: row.fullField},
                    h("td", {}, row.object),
                    h("td", {}, h("code", {}, row.field)),
                    h("td", {},
                      h("span", {
                        className: "slds-badge " + (row.edit ? "fp-badge-rw" : "fp-badge-r"),
                      }, row.access))
                  )
                )
              )
            ),
            ps && model.fields.length === 0 && model.spinnerCount === 0 &&
              h("div", {className: "fp-empty"}, "This permission set grants no field-level access."),
            ps && model.fields.length > 0 && rows.length === 0 &&
              h("div", {className: "fp-empty"}, "No fields match the filter.")
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
