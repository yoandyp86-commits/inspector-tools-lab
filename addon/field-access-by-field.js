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
    this.title = "Access by Field";
    this.errorMessages = [];

    this.searchedField = "";  // last field searched, e.g. "Order.IsPendingBaja__c"
    this.rows = [];           // permission set / profile rows
    this.filter = "";
    this.hasSearched = false;

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

  search(rawField) {
    const field = (rawField || "").trim();
    this.errorMessages = [];
    if (!field) return;
    if (!field.includes(".")) {
      this.errorMessages.push("Enter the field as Object.Field (e.g. Opportunity.GVAlumnoExternalId__c).");
      this.didUpdate();
      return;
    }
    this.searchedField = field;
    this.rows = [];
    this.filter = "";
    this.hasSearched = true;
    this.didUpdate();

    const escaped = field.replace(/'/g, "\\'");
    const soql = "SELECT ParentId, Parent.Label, Parent.Profile.Name, Parent.ProfileId, Parent.IsOwnedByProfile, PermissionsRead, PermissionsEdit"
      + " FROM FieldPermissions WHERE Field = '" + escaped + "'"
      + " ORDER BY Parent.IsOwnedByProfile DESC, PermissionsEdit DESC, Parent.Label";
    const promise = sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
    this.spinFor("loading field access", promise, (res) => {
      this.rows = (res.records || []).map(r => {
        const isProfile = !!(r.Parent && r.Parent.IsOwnedByProfile);
        const profileName = r.Parent && r.Parent.Profile && r.Parent.Profile.Name;
        const parentName = isProfile
          ? (profileName || (r.Parent && r.Parent.Label) || "(unknown profile)")
          : ((r.Parent && r.Parent.Label) || "(unknown)");
        const profileId = r.Parent && r.Parent.ProfileId;
        let link = null;
        if (isProfile && profileId) {
          link = this.sfLink + "/lightning/setup/EnhancedProfiles/page?address=%2F" + profileId;
        } else if (!isProfile && r.ParentId) {
          link = this.sfLink + "/lightning/setup/PermSets/page?address=%2F" + r.ParentId;
        }
        return {
          parent: parentName,
          link,
          isProfile,
          type: isProfile ? "Profile" : "Permission Set",
          read: !!r.PermissionsRead,
          edit: !!r.PermissionsEdit,
          access: r.PermissionsEdit ? "Read & Edit" : (r.PermissionsRead ? "Read" : "None"),
        };
      });
    });
  }

  filteredRows() {
    const f = this.filter.trim().toLowerCase();
    if (!f) return this.rows;
    return this.rows.filter(row =>
      row.parent.toLowerCase().includes(f)
      || row.type.toLowerCase().includes(f));
  }

  copyAsCsv() {
    const rows = this.filteredRows();
    const header = "Parent,Type,Access";
    const body = rows.map(r => "\"" + r.parent.replace(/"/g, "\"\"") + "\"," + r.type + "," + r.access).join("\n");
    copyToClipboard(header + "\n" + body);
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.model = this.props.vm;
    this.state = {input: ""};
    this.onInput = this.onInput.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onSearch = this.onSearch.bind(this);
    this.onCopy = this.onCopy.bind(this);
    this.onFilter = this.onFilter.bind(this);
  }

  onInput(e) { this.setState({input: e.target.value}); }
  onKeyDown(e) { if (e.key === "Enter") { e.preventDefault(); this.onSearch(); } }
  onSearch() { this.model.search(this.state.input); }
  onCopy() { this.model.copyAsCsv(); this.model.didUpdate(); }
  onFilter(e) { this.model.filter = e.target.value; this.model.didUpdate(); }

  render() {
    let model = this.props.vm;
    document.title = model.title;
    const rows = model.filteredRows();
    return h("div", {},
      h(PageHeader, {
        pageTitle: "Access by Field",
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
              h("label", {className: "slds-form-element__label"}, "Field (Object.Field)"),
              h("div", {className: "slds-grid slds-grid_vertical-align-center"},
                h("div", {className: "slds-form-element__control slds-input-has-icon slds-input-has-icon_left slds-m-right_x-small", style: {flex: "1"}},
                  h("svg", {className: "slds-icon slds-input__icon slds-input__icon_left slds-icon-text-default", viewBox: "0 0 520 520"},
                    h("use", {xlinkHref: "symbols.svg#search"})),
                  h("input", {
                    type: "search",
                    className: "slds-input",
                    placeholder: "e.g. Opportunity.GVAlumnoExternalId__c",
                    value: this.state.input,
                    autoFocus: true,
                    onChange: this.onInput,
                    onKeyDown: this.onKeyDown,
                  })
                ),
                h("button", {
                  className: "slds-button slds-button_brand",
                  onClick: this.onSearch,
                }, "Search")
              )
            )
          ),
          h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1", overflowY: "auto", minHeight: 0}},
            model.errorMessages.length > 0 &&
              h("div", {className: "slds-notify slds-notify_alert slds-theme_error slds-m-bottom_small", role: "alert"},
                model.errorMessages[model.errorMessages.length - 1]),
            !model.hasSearched && h("div", {className: "fa-empty"}, "Type a field as Object.Field (e.g. Opportunity.GVAlumnoExternalId__c) and press Search to see which profiles and permission sets grant access to it."),
            model.hasSearched && h("div", {className: "slds-m-bottom_small slds-grid slds-grid_vertical-align-center slds-wrap"},
              h("div", {className: "slds-col slds-size_1-of-2"},
                h("h2", {className: "slds-text-heading_small"}, h("code", {}, model.searchedField)),
                h("p", {className: "slds-text-body_small slds-text-color_weak"},
                  model.rows.length + " grant(s)")
              ),
              h("div", {className: "slds-col slds-size_1-of-2 slds-text-align_right slds-grid slds-grid_align-end slds-grid_vertical-align-center"},
                h("input", {
                  type: "search",
                  className: "slds-input fa-filter-input slds-m-right_x-small",
                  placeholder: "Filter by parent or type",
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
            model.hasSearched && rows.length > 0 && h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped"},
              h("thead", {},
                h("tr", {className: "slds-line-height_reset"},
                  h("th", {}, "Parent"),
                  h("th", {}, "Type"),
                  h("th", {}, "Access")
                )
              ),
              h("tbody", {},
                rows.map((row, idx) =>
                  h("tr", {key: row.parent + "_" + idx},
                    h("td", {},
                      row.link
                        ? h("a", {href: row.link, target: "_blank", rel: "noopener noreferrer"}, row.parent)
                        : row.parent),
                    h("td", {},
                      h("span", {
                        className: "slds-badge " + (row.isProfile ? "fa-badge-profile" : "fa-badge-ps"),
                      }, row.type)),
                    h("td", {},
                      h("span", {
                        className: "slds-badge " + (row.edit ? "fa-badge-rw" : "fa-badge-r"),
                      }, row.access))
                  )
                )
              )
            ),
            model.hasSearched && model.rows.length === 0 && model.spinnerCount === 0 && model.errorMessages.length === 0 &&
              h("div", {className: "fa-empty"}, "No profile or permission set grants access to this field."),
            model.hasSearched && model.rows.length > 0 && rows.length === 0 &&
              h("div", {className: "fa-empty"}, "No rows match the filter.")
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
