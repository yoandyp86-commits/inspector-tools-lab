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

    this.mode = "field";      // "field" or "object"
    this.searchedLabel = "";  // what we searched, shown in the header
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

  // Build the Setup link for a parent (profile or permission set).
  buildLink(isProfile, profileId, parentId) {
    if (isProfile && profileId) {
      return this.sfLink + "/lightning/setup/EnhancedProfiles/page?address=%2F" + profileId;
    } else if (!isProfile && parentId) {
      return this.sfLink + "/lightning/setup/PermSets/page?address=%2F" + parentId;
    }
    return null;
  }

  parentNameFrom(r, isProfile) {
    const profileName = r.Parent && r.Parent.Profile && r.Parent.Profile.Name;
    return isProfile
      ? (profileName || (r.Parent && r.Parent.Label) || "(unknown profile)")
      : ((r.Parent && r.Parent.Label) || "(unknown)");
  }

  // Decide which search to run based on the two inputs.
  search(rawObject, rawField) {
    const objectName = (rawObject || "").trim();
    const fieldInput = (rawField || "").trim();
    this.errorMessages = [];

    if (fieldInput) {
      // Field mode. Accept "Object.Field" or just "Field" when object box also filled.
      let fieldPath = fieldInput;
      if (!fieldPath.includes(".")) {
        if (objectName) {
          fieldPath = objectName + "." + fieldInput;
        } else {
          this.errorMessages.push("Enter the field as Object.Field, or fill the Object box too.");
          this.didUpdate();
          return;
        }
      }
      this.searchField(fieldPath);
      return;
    }

    if (objectName) {
      this.searchObject(objectName);
      return;
    }

    this.errorMessages.push("Enter an object (e.g. Order) to see object permissions, or a field (e.g. Order.IsPendingBaja__c) to see field permissions.");
    this.didUpdate();
  }

  searchField(fieldPath) {
    this.mode = "field";
    this.searchedLabel = fieldPath;
    this.rows = [];
    this.filter = "";
    this.hasSearched = true;
    this.didUpdate();

    const escaped = fieldPath.replace(/'/g, "\\'");
    const soql = "SELECT ParentId, Parent.Label, Parent.Profile.Name, Parent.ProfileId, Parent.IsOwnedByProfile, PermissionsRead, PermissionsEdit"
      + " FROM FieldPermissions WHERE Field = '" + escaped + "'"
      + " ORDER BY Parent.IsOwnedByProfile DESC, PermissionsEdit DESC, Parent.Label";
    const promise = sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
    this.spinFor("loading field access", promise, (res) => {
      this.rows = (res.records || []).map(r => {
        const isProfile = !!(r.Parent && r.Parent.IsOwnedByProfile);
        return {
          parent: this.parentNameFrom(r, isProfile),
          link: this.buildLink(isProfile, r.Parent && r.Parent.ProfileId, r.ParentId),
          isProfile,
          type: isProfile ? "Profile" : "Permission Set",
          read: !!r.PermissionsRead,
          edit: !!r.PermissionsEdit,
          access: r.PermissionsEdit ? "Read & Edit" : (r.PermissionsRead ? "Read" : "None"),
        };
      });
    });
  }

  searchObject(objectName) {
    this.mode = "object";
    this.searchedLabel = objectName;
    this.rows = [];
    this.filter = "";
    this.hasSearched = true;
    this.didUpdate();

    const escaped = objectName.replace(/'/g, "\\'");
    const soql = "SELECT ParentId, Parent.Label, Parent.Profile.Name, Parent.ProfileId, Parent.IsOwnedByProfile,"
      + " PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete,"
      + " PermissionsViewAllRecords, PermissionsModifyAllRecords"
      + " FROM ObjectPermissions WHERE SObjectType = '" + escaped + "'"
      + " ORDER BY Parent.IsOwnedByProfile DESC, Parent.Label";
    const promise = sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
    this.spinFor("loading object access", promise, (res) => {
      this.rows = (res.records || []).map(r => {
        const isProfile = !!(r.Parent && r.Parent.IsOwnedByProfile);
        return {
          parent: this.parentNameFrom(r, isProfile),
          link: this.buildLink(isProfile, r.Parent && r.Parent.ProfileId, r.ParentId),
          isProfile,
          type: isProfile ? "Profile" : "Permission Set",
          read: !!r.PermissionsRead,
          create: !!r.PermissionsCreate,
          edit: !!r.PermissionsEdit,
          del: !!r.PermissionsDelete,
          viewAll: !!r.PermissionsViewAllRecords,
          modifyAll: !!r.PermissionsModifyAllRecords,
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
    let header, body;
    if (this.mode === "object") {
      header = "Parent,Type,Read,Create,Edit,Delete,View All,Modify All";
      const yn = (b) => b ? "Yes" : "";
      body = rows.map(r => "\"" + r.parent.replace(/"/g, "\"\"") + "\"," + r.type + ","
        + yn(r.read) + "," + yn(r.create) + "," + yn(r.edit) + "," + yn(r.del) + ","
        + yn(r.viewAll) + "," + yn(r.modifyAll)).join("\n");
    } else {
      header = "Parent,Type,Access";
      body = rows.map(r => "\"" + r.parent.replace(/"/g, "\"\"") + "\"," + r.type + "," + r.access).join("\n");
    }
    copyToClipboard(header + "\n" + body);
  }
}

function PermCell({on}) {
  return on
    ? h("span", {className: "slds-badge fa-badge-rw", title: "Yes"}, "\u2713")
    : h("span", {className: "fa-perm-off", title: "No"}, "\u2013");
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.model = this.props.vm;
    this.state = {objectInput: "", fieldInput: ""};
    this.onObjectInput = this.onObjectInput.bind(this);
    this.onFieldInput = this.onFieldInput.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onSearch = this.onSearch.bind(this);
    this.onCopy = this.onCopy.bind(this);
    this.onFilter = this.onFilter.bind(this);
  }

  onObjectInput(e) { this.setState({objectInput: e.target.value}); }
  onFieldInput(e) { this.setState({fieldInput: e.target.value}); }
  onKeyDown(e) { if (e.key === "Enter") { e.preventDefault(); this.onSearch(); } }
  onSearch() { this.model.search(this.state.objectInput, this.state.fieldInput); }
  onCopy() { this.model.copyAsCsv(); this.model.didUpdate(); }
  onFilter(e) { this.model.filter = e.target.value; this.model.didUpdate(); }

  render() {
    let model = this.props.vm;
    document.title = model.title;
    const rows = model.filteredRows();
    const isObject = model.mode === "object";
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
            h("div", {className: "slds-grid slds-gutters slds-grid_vertical-align-end slds-wrap"},
              h("div", {className: "slds-col", style: {minWidth: "14rem"}},
                h("div", {className: "slds-form-element"},
                  h("label", {className: "slds-form-element__label"}, "Object (object permissions)"),
                  h("div", {className: "slds-form-element__control slds-input-has-icon slds-input-has-icon_left"},
                    h("svg", {className: "slds-icon slds-input__icon slds-input__icon_left slds-icon-text-default", viewBox: "0 0 520 520"},
                      h("use", {xlinkHref: "symbols.svg#search"})),
                    h("input", {
                      type: "search",
                      className: "slds-input",
                      placeholder: "e.g. Order",
                      value: this.state.objectInput,
                      autoFocus: true,
                      onChange: this.onObjectInput,
                      onKeyDown: this.onKeyDown,
                    })
                  )
                )
              ),
              h("div", {className: "slds-col", style: {minWidth: "18rem", flex: "2"}},
                h("div", {className: "slds-form-element"},
                  h("label", {className: "slds-form-element__label"}, "Field (field permissions)"),
                  h("div", {className: "slds-form-element__control slds-input-has-icon slds-input-has-icon_left"},
                    h("svg", {className: "slds-icon slds-input__icon slds-input__icon_left slds-icon-text-default", viewBox: "0 0 520 520"},
                      h("use", {xlinkHref: "symbols.svg#search"})),
                    h("input", {
                      type: "search",
                      className: "slds-input",
                      placeholder: "e.g. Order.IsPendingBaja__c (or just the field if Object is filled)",
                      value: this.state.fieldInput,
                      onChange: this.onFieldInput,
                      onKeyDown: this.onKeyDown,
                    })
                  )
                )
              ),
              h("div", {className: "slds-col slds-grow-none"},
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
            !model.hasSearched && h("div", {className: "fa-empty"}, "Enter an Object (e.g. Order) to see which profiles and permission sets have object permissions (Read, Create, Edit, Delete, View All, Modify All). Or enter a Field to see field-level access."),
            model.hasSearched && h("div", {className: "slds-m-bottom_small slds-grid slds-grid_vertical-align-center slds-wrap"},
              h("div", {className: "slds-col slds-size_1-of-2"},
                h("h2", {className: "slds-text-heading_small"},
                  h("code", {}, model.searchedLabel),
                  h("span", {className: "slds-m-left_x-small slds-badge " + (isObject ? "fa-badge-profile" : "fa-badge-ps")},
                    isObject ? "Object permissions" : "Field permissions")),
                h("p", {className: "slds-text-body_small slds-text-color_weak"},
                  model.rows.length + (isObject ? " assignment(s)" : " grant(s)"))
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
            // Object-permissions table
            model.hasSearched && isObject && rows.length > 0 && h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped fa-perm-table"},
              h("thead", {},
                h("tr", {className: "slds-line-height_reset"},
                  h("th", {}, "Parent"),
                  h("th", {}, "Type"),
                  h("th", {className: "slds-text-align_center"}, "Read"),
                  h("th", {className: "slds-text-align_center"}, "Create"),
                  h("th", {className: "slds-text-align_center"}, "Edit"),
                  h("th", {className: "slds-text-align_center"}, "Delete"),
                  h("th", {className: "slds-text-align_center"}, "View All"),
                  h("th", {className: "slds-text-align_center"}, "Modify All")
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
                      h("span", {className: "slds-badge " + (row.isProfile ? "fa-badge-profile" : "fa-badge-ps")}, row.type)),
                    h("td", {className: "slds-text-align_center"}, h(PermCell, {on: row.read})),
                    h("td", {className: "slds-text-align_center"}, h(PermCell, {on: row.create})),
                    h("td", {className: "slds-text-align_center"}, h(PermCell, {on: row.edit})),
                    h("td", {className: "slds-text-align_center"}, h(PermCell, {on: row.del})),
                    h("td", {className: "slds-text-align_center"}, h(PermCell, {on: row.viewAll})),
                    h("td", {className: "slds-text-align_center"}, h(PermCell, {on: row.modifyAll}))
                  )
                )
              )
            ),
            // Field-permissions table
            model.hasSearched && !isObject && rows.length > 0 && h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped"},
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
                      h("span", {className: "slds-badge " + (row.isProfile ? "fa-badge-profile" : "fa-badge-ps")}, row.type)),
                    h("td", {},
                      h("span", {className: "slds-badge " + (row.edit ? "fa-badge-rw" : "fa-badge-r")}, row.access))
                  )
                )
              )
            ),
            model.hasSearched && model.rows.length === 0 && model.spinnerCount === 0 && model.errorMessages.length === 0 &&
              h("div", {className: "fa-empty"}, isObject ? "No profile or permission set has permissions on this object." : "No profile or permission set grants access to this field."),
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
