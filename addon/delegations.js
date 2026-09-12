/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {PageHeader} from "./components/PageHeader.js";
import {UserInfoModel, copyToClipboard} from "./utils.js";
/* global initButton */

let h = React.createElement;

class Model {
  constructor(sfHost, userId) {
    this.reactCallback = null;
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.title = "Delegations";
    this.errorMessages = [];

    this.userId = userId;
    this.selectedUser = null;
    this.delegations = [];
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
    if (this.reactCallback) {
      this.reactCallback(cb);
    }
  }

  spinFor(actionName, promise, cb) {
    this.spinnerCount++;
    return promise
      .then(res => {
        this.spinnerCount--;
        cb(res);
        this.didUpdate();
      })
      .catch(err => {
        console.error(err);
        this.errorMessages.push("Error " + actionName + ": " + err.message);
        this.spinnerCount--;
        this.didUpdate();
      });
  }

  startLoading() {
    if (!this.userId) {
      this.errorMessages.push("No user id provided in the URL (?user=...).");
      this.didUpdate();
      return;
    }
    this.loadUser(this.userId);
    this.loadDelegations(this.userId);
  }

  loadUser(userId) {
    const soql = "SELECT Id, Name, Username, Alias, IsActive, Profile.Name FROM User"
      + " WHERE Id = '" + userId + "' WITH USER_MODE LIMIT 1";
    const promise = sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
    this.spinFor("loading user", promise, (res) => {
      this.selectedUser = (res.records && res.records[0]) || null;
    });
  }

  loadDelegations(userId) {
    const soql = "SELECT Id, Name, User__c, UserName__c, Delegation__c, Delegation__r.Name,"
      + " Rol__c, IsDelegate__c, Disponible__c"
      + " FROM DelegationUser__c WHERE User__c = '" + userId + "'"
      + " ORDER BY Delegation__r.Name, Rol__c";
    const promise = sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
    this.spinFor("loading delegations", promise, (res) => {
      this.delegations = (res.records || []).map(r => ({
        id: r.Id,
        name: r.Name,
        userName: r.UserName__c || "",
        delegationId: r.Delegation__c || "",
        delegationName: (r.Delegation__r && r.Delegation__r.Name) || "",
        rol: r.Rol__c || "",
        isDelegate: !!r.IsDelegate__c,
        disponible: !!r.Disponible__c,
      }));
    });
  }

  filteredRows() {
    const f = this.filter.trim().toLowerCase();
    if (!f) {
      return this.delegations;
    }
    return this.delegations.filter(row =>
      (row.delegationName + " " + row.rol + " " + row.userName + " "
        + row.delegationId + " " + row.name).toLowerCase().includes(f));
  }

  copyAsJson() {
    copyToClipboard(JSON.stringify(this.filteredRows(), null, "  "));
  }

  copyAsCsv() {
    const esc = v => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ["Delegation", "Delegation Id", "Rol", "User Name", "Is Delegate", "Disponible", "Record", "Record Id"];
    const lines = [header.join(",")];
    this.filteredRows().forEach(row => {
      lines.push([
        esc(row.delegationName), esc(row.delegationId), esc(row.rol), esc(row.userName),
        esc(row.isDelegate ? "Yes" : "No"), esc(row.disponible ? "Yes" : "No"),
        esc(row.name), esc(row.id),
      ].join(","));
    });
    copyToClipboard(lines.join("\n"));
  }

  setupLink(row) {
    return this.sfLink + "/lightning/r/DelegationUser__c/" + row.id + "/view";
  }

  delegationLink(row) {
    return this.sfLink + "/lightning/r/" + row.delegationId + "/view";
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.model = this.props.vm;
    this.onCopyJson = this.onCopyJson.bind(this);
    this.onCopyCsv = this.onCopyCsv.bind(this);
    this.onFilter = this.onFilter.bind(this);
  }

  onCopyJson() {
    this.model.copyAsJson();
    this.model.didUpdate();
  }

  onCopyCsv() {
    this.model.copyAsCsv();
    this.model.didUpdate();
  }

  onFilter(e) {
    this.model.filter = e.target.value;
    this.model.didUpdate();
  }

  render() {
    let model = this.props.vm;
    document.title = model.title;
    const user = model.selectedUser;
    const rows = model.filteredRows();
    return h("div", {},
      h(PageHeader, {
        pageTitle: "Delegations",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        ...model.userInfoModel.getProps()
      }),
      h("div", {className: "slds-m-top_xx-large sfir-page-container"},
        h("div", {className: "slds-card slds-m-around_medium", style: {flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0}},
          h("div", {className: "slds-card__header slds-p-horizontal_small slds-p-top_small"},
            model.errorMessages.length > 0 &&
              h("div", {className: "slds-notify slds-notify_alert slds-theme_error slds-m-bottom_small", role: "alert"},
                model.errorMessages[model.errorMessages.length - 1]),
            user && h("div", {className: "slds-grid slds-grid_vertical-align-center"},
              h("div", {className: "slds-col"},
                h("h2", {className: "slds-text-heading_small"}, user.Name + " (" + user.Alias + ")"),
                h("p", {className: "slds-text-body_small slds-text-color_weak"},
                  user.Username + (user.Profile ? " \u00b7 " + user.Profile.Name : "")
                  + (user.IsActive ? "" : " \u00b7 \u26a0 Inactive"))
              ),
              h("div", {className: "slds-col slds-text-align_right"},
                h("button", {
                  className: "slds-button slds-button_neutral",
                  disabled: rows.length === 0,
                  onClick: this.onCopyCsv,
                  title: "Copy delegations as CSV",
                }, "Copy CSV"),
                h("button", {
                  className: "slds-button slds-button_neutral",
                  disabled: rows.length === 0,
                  onClick: this.onCopyJson,
                  title: "Copy delegations as JSON",
                }, "Copy JSON")
              )
            )
          ),
          user && model.delegations.length > 0 &&
            h("div", {className: "slds-p-horizontal_small slds-p-bottom_small"},
              h("input", {
                type: "search",
                className: "slds-input deleg-filter",
                placeholder: "Filter\u2026",
                value: model.filter,
                onChange: this.onFilter,
              })
            ),
          h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1", overflowY: "auto", minHeight: 0}},
            user && rows.length > 0 && h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered"},
              h("thead", {},
                h("tr", {className: "slds-line-height_reset"},
                  h("th", {}, "Delegation"),
                  h("th", {}, "Delegation Id"),
                  h("th", {}, "Rol"),
                  h("th", {}, "Is Delegate"),
                  h("th", {}, "Disponible"),
                  h("th", {}, "")
                )
              ),
              h("tbody", {},
                rows.map(row =>
                  h("tr", {key: row.id},
                    h("td", {},
                      row.delegationId
                        ? h("a", {href: model.delegationLink(row), target: "_blank", rel: "noopener"}, row.delegationName || row.delegationId)
                        : (row.delegationName || "\u2014")),
                    h("td", {}, row.delegationId ? h("code", {}, row.delegationId) : "\u2014"),
                    h("td", {}, row.rol || "\u2014"),
                    h("td", {},
                      h("span", {
                        className: "slds-badge " + (row.isDelegate ? "deleg-badge-yes" : "deleg-badge-no"),
                      }, row.isDelegate ? "Yes" : "No")),
                    h("td", {},
                      h("span", {
                        className: "slds-badge " + (row.disponible ? "deleg-badge-yes" : "deleg-badge-no"),
                      }, row.disponible ? "Yes" : "No")),
                    h("td", {},
                      h("a", {href: model.setupLink(row), target: "_blank", rel: "noopener"}, "Open"))
                  )
                )
              )
            ),
            user && model.delegations.length > 0 && rows.length === 0 && model.spinnerCount === 0 &&
              h("div", {className: "deleg-empty"}, "No delegations match the filter."),
            user && model.delegations.length === 0 && model.spinnerCount === 0 &&
              h("div", {className: "deleg-empty"}, "No delegations found for this user."),
            !user && model.spinnerCount === 0 && model.errorMessages.length === 0 &&
              h("div", {className: "deleg-empty"}, "Loading user\u2026")
          )
        )
      )
    );
  }
}

{
  let args = new URLSearchParams(location.search.slice(1));
  let sfHost = args.get("host");
  let userId = args.get("user");
  initButton(sfHost, true);
  sfConn.getSession(sfHost).then(() => {
    let root = document.getElementById("root");
    let vm = new Model(sfHost, userId);
    vm.reactCallback = cb => {
      ReactDOM.render(h(App, {vm}), root, cb);
    };
    ReactDOM.render(h(App, {vm}), root);
    vm.startLoading();
  });
}
