/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {PageHeader} from "./components/PageHeader.js";
import {UserInfoModel, copyToClipboard} from "./utils.js";
/* global initButton */

let h = React.createElement;
const SEARCH_LIMIT = 50;

class Model {
  constructor(sfHost) {
    this.reactCallback = null;
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.title = "Field Permissions";
    this.errorMessages = [];

    this.selectedPS = null;   // {Id, Name, Label, kind}
    this.searchResults = [];  // normalized PS rows from the last search
    this.searchedQuery = "";  // text used in the last search
    this.searchDone = false;
    this.searchHasMore = false;
    this.resultsVisible = false;
    this.includeProfiles = false;
    this.searchSeq = 0;       // ignores stale responses
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

  static escapeLike(text) {
    return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/%/g, "\\%").replace(/_/g, "\\_");
  }

  static normalizePS(r) {
    const isProfile = !!r.IsOwnedByProfile;
    const isGroup = !!r.PermissionSetGroupId;
    return {
      Id: r.Id,
      Name: r.Name,
      Label: isProfile ? (r.Profile && r.Profile.Name) || r.Label : r.Label,
      kind: isProfile ? "Profile" : (isGroup ? "Group" : "Permission Set"),
    };
  }

  runSearch(query) {
    query = query.trim();
    if (!query) return;
    const like = "'%" + Model.escapeLike(query) + "%'";
    let where = "(IsOwnedByProfile = false AND (Label LIKE " + like + " OR Name LIKE " + like + "))";
    if (this.includeProfiles) {
      where = "(" + where + " OR (IsOwnedByProfile = true AND Profile.Name LIKE " + like + "))";
    }
    const soql = "SELECT Id, Name, Label, Type, PermissionSetGroupId, IsOwnedByProfile, Profile.Name"
      + " FROM PermissionSet WHERE " + where + " LIMIT " + (SEARCH_LIMIT + 1);
    const seq = ++this.searchSeq;
    this.errorMessages = [];
    this.didUpdate();
    const promise = sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
    this.spinFor("searching permission sets", promise, (res) => {
      if (seq !== this.searchSeq) return;
      const rows = (res.records || []).map(Model.normalizePS)
        .sort((a, b) => a.Label.localeCompare(b.Label));
      this.searchHasMore = rows.length > SEARCH_LIMIT;
      this.searchResults = rows.slice(0, SEARCH_LIMIT);
      this.searchedQuery = query;
      this.searchDone = true;
      this.resultsVisible = true;
    });
  }

  setIncludeProfiles(value, currentQuery) {
    this.includeProfiles = value;
    // Re-run the last search so the list reflects the checkbox.
    const q = (currentQuery || "").trim() || this.searchedQuery;
    if (this.searchDone && q) {
      this.runSearch(q);
    } else {
      this.didUpdate();
    }
  }

  showResults() {
    this.resultsVisible = true;
    this.didUpdate();
  }

  hideResults() {
    this.resultsVisible = false;
    this.didUpdate();
  }

  selectPS(ps) {
    this.selectedPS = ps;
    this.resultsVisible = false;
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
  // React 15: functional components must return an element, never a bare string.
  text = text || "";
  const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (i < 0) return h("span", {}, text);
  return h("span", {},
    text.slice(0, i),
    h("mark", {}, text.slice(i, i + query.length)),
    text.slice(i + query.length));
}

class PSSearch extends React.Component {
  constructor(props) {
    super(props);
    this.state = {query: "", activeIndex: -1};
    this.onChange = this.onChange.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onSearch = this.onSearch.bind(this);
    this.onToggleProfiles = this.onToggleProfiles.bind(this);
    this.listEl = null;
    this.setListEl = (el) => { this.listEl = el; };
  }

  componentWillReceiveProps() {
    // New results arrive through the model: reset keyboard highlight.
    this.setState({activeIndex: -1});
  }

  onChange(e) { this.setState({query: e.target.value}); }

  onSearch() {
    this.setState({activeIndex: -1});
    this.props.model.runSearch(this.state.query);
  }

  onToggleProfiles(e) {
    this.props.model.setIncludeProfiles(e.target.checked, this.state.query);
  }

  pick(ps) {
    this.setState({activeIndex: -1});
    this.props.model.selectPS(ps);
  }

  moveActive(index) {
    this.setState({activeIndex: index}, () => {
      const item = this.listEl && this.listEl.children[index];
      if (item && item.scrollIntoView) item.scrollIntoView({block: "nearest"});
    });
  }

  onKeyDown(e) {
    const {model} = this.props;
    const {activeIndex} = this.state;
    const results = model.resultsVisible ? model.searchResults : [];
    if (e.key === "ArrowDown" && results.length) {
      e.preventDefault();
      this.moveActive(Math.min(activeIndex + 1, results.length - 1));
    } else if (e.key === "ArrowUp" && results.length) {
      e.preventDefault();
      this.moveActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && results[activeIndex]) {
        this.pick(results[activeIndex]);
      } else {
        this.onSearch();
      }
    } else if (e.key === "Escape") {
      model.hideResults();
    }
  }

  render() {
    const {model} = this.props;
    const {query, activeIndex} = this.state;
    const results = model.searchResults;
    const canSearch = query.trim().length > 0 && model.spinnerCount === 0;
    return h("div", {className: "fp-search-wrapper"},
      h("div", {className: "slds-form-element"},
        h("label", {className: "slds-form-element__label"}, "Search permission set"),
        h("div", {className: "fp-search-row"},
          h("div", {className: "slds-form-element__control slds-input-has-icon slds-input-has-icon_left fp-search-input"},
            h("svg", {className: "slds-icon slds-input__icon slds-input__icon_left slds-icon-text-default", viewBox: "0 0 520 520"},
              h("use", {xlinkHref: "symbols.svg#search"})),
            h("input", {
              type: "search",
              className: "slds-input",
              placeholder: "Part of the label or API name",
              value: query,
              autoFocus: true,
              onChange: this.onChange,
              onKeyDown: this.onKeyDown,
            })
          ),
          h("button", {
            className: "slds-button slds-button_brand",
            disabled: !canSearch,
            onClick: this.onSearch,
          }, "Search")
        ),
        h("div", {className: "slds-checkbox slds-m-top_x-small"},
          h("input", {
            type: "checkbox",
            id: "fp-include-profiles",
            checked: model.includeProfiles,
            onChange: this.onToggleProfiles,
          }),
          h("label", {className: "slds-checkbox__label", htmlFor: "fp-include-profiles"},
            h("span", {className: "slds-checkbox_faux"}),
            h("span", {className: "slds-form-element__label"}, "Include profiles")
          )
        )
      ),
      model.resultsVisible && model.searchDone && h("div", {className: "fp-results"},
        results.length === 0
          ? h("div", {className: "fp-result-item fp-sub"}, "No permission sets found for \u00ab" + model.searchedQuery + "\u00bb")
          : h("div", {ref: this.setListEl},
            results.map((ps, idx) =>
              h("div", {
                key: ps.Id,
                className: "fp-result-item" + (idx === activeIndex ? " fp-active" : "")
                  + (model.selectedPS && model.selectedPS.Id === ps.Id ? " fp-selected" : ""),
                onClick: () => this.pick(ps),
              },
              h("div", {}, h(Mark, {text: ps.Label, query: model.searchedQuery})),
              h("div", {className: "fp-sub"},
                h(Mark, {text: ps.Name, query: model.searchedQuery}),
                " \u00b7 ",
                h("span", {className: "fp-kind fp-kind-" + ps.kind.replace(/ /g, "").toLowerCase()}, ps.kind))
              )
            )
          ),
        model.searchHasMore && h("div", {className: "fp-result-item fp-sub fp-more"},
          "Showing the first " + SEARCH_LIMIT + " results, refine the search.")
      )
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
                h("h2", {className: "slds-text-heading_small"},
                  ps.Label,
                  !model.resultsVisible && model.searchResults.length > 0 && h("a", {
                    className: "slds-m-left_small slds-text-body_small",
                    href: "#",
                    onClick: (e) => { e.preventDefault(); model.showResults(); },
                  }, "Change")),
                h("p", {className: "slds-text-body_small slds-text-color_weak"},
                  ps.Name + " · " + ps.kind + " · " + model.fields.length + " field permission(s)")
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
