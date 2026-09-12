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
    this.title = "Permission Sets";
    this.errorMessages = [];

    this.userId = userId;
    this.selectedUser = null;
    this.assignments = [];

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
    this.loadAssignments(this.userId);
  }

  loadUser(userId) {
    const soql = "SELECT Id, Name, Username, Alias, IsActive, Profile.Name FROM User"
      + " WHERE Id = '" + userId + "' WITH USER_MODE LIMIT 1";
    const promise = sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
    this.spinFor("loading user", promise, (res) => {
      this.selectedUser = (res.records && res.records[0]) || null;
    });
  }

  loadAssignments(userId) {
    // PermissionSet rows with a PermissionSetGroupId are the auto-generated set behind a
    // permission set group; we surface the group's name/label instead when present.
    const soql = "SELECT PermissionSet.Id, PermissionSet.Name, PermissionSet.Label, PermissionSet.Type,"
      + " PermissionSet.IsOwnedByProfile, PermissionSet.License.Name,"
      + " PermissionSet.PermissionSetGroupId, PermissionSet.PermissionSetGroup.DeveloperName,"
      + " PermissionSet.PermissionSetGroup.MasterLabel, PermissionSet.PermissionSetGroup.Status"
      + " FROM PermissionSetAssignment WHERE AssigneeId = '" + userId + "'"
      + " ORDER BY PermissionSet.Type, PermissionSet.Label";
    const promise = sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
    this.spinFor("loading assignments", promise, (res) => {
      this.assignments = (res.records || [])
        .map(r => {
          const ps = r.PermissionSet || {};
          const grp = ps.PermissionSetGroup;
          const isGroup = !!ps.PermissionSetGroupId;
          return {
            id: isGroup && grp ? grp.DeveloperName : ps.Id,
            label: isGroup && grp ? grp.MasterLabel : ps.Label,
            apiName: isGroup && grp ? grp.DeveloperName : ps.Name,
            type: isGroup ? "Group" : "Set",
            license: ps.License ? ps.License.Name : "",
            status: isGroup && grp ? grp.Status : "",
            ownedByProfile: !!ps.IsOwnedByProfile,
            psetId: ps.Id,
            groupId: ps.PermissionSetGroupId || null,
          };
        })
        .filter(row => !row.ownedByProfile);
    });
  }

  copyAsJson() {
    copyToClipboard(JSON.stringify(this.assignments, null, "  "));
  }

  setupLink(row) {
    if (row.type === "Group") {
      return this.sfLink + "/lightning/setup/PermSetGroups/page?address=%2F" + row.groupId;
    }
    return this.sfLink + "/lightning/setup/PermSets/page?address=%2F" + row.psetId;
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.model = this.props.vm;
    this.onCopy = this.onCopy.bind(this);
  }

  onCopy() {
    this.model.copyAsJson();
    this.model.didUpdate();
  }

  render() {
    let model = this.props.vm;
    document.title = model.title;
    const user = model.selectedUser;
    return h("div", {},
      h(PageHeader, {
        pageTitle: "Permission Sets",
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
                  disabled: model.assignments.length === 0,
                  onClick: this.onCopy,
                  title: "Copy assignments as JSON",
                }, "Copy JSON"),
                h("a", {
                  className: "slds-button slds-button_neutral",
                  href: model.sfLink + "/lightning/setup/PermSets/page?address=%2Fudd%2FPermissionSet%2FassignPermissionSet.apexp%3FuserId%3D" + user.Id,
                  target: "_blank",
                  rel: "noopener",
                }, "Assign in Setup")
              )
            )
          ),
          h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1", overflowY: "auto", minHeight: 0}},
            user && model.assignments.length > 0 && h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered"},
              h("thead", {},
                h("tr", {className: "slds-line-height_reset"},
                  h("th", {}, "Label"),
                  h("th", {}, "API Name"),
                  h("th", {}, "Type"),
                  h("th", {}, "License"),
                  h("th", {}, "Status"),
                  h("th", {}, "")
                )
              ),
              h("tbody", {},
                model.assignments.map(row =>
                  h("tr", {key: row.type + "-" + row.id},
                    h("td", {}, row.label),
                    h("td", {}, h("code", {}, row.apiName)),
                    h("td", {},
                      h("span", {
                        className: "slds-badge " + (row.type === "Group" ? "ps-badge-group" : "ps-badge-set"),
                      }, row.type === "Group" ? "Set Group" : "Permission Set")),
                    h("td", {}, row.license || "\u2014"),
                    h("td", {}, row.status || "\u2014"),
                    h("td", {},
                      h("a", {href: model.setupLink(row), target: "_blank", rel: "noopener"}, "Open"))
                  )
                )
              )
            ),
            user && model.assignments.length === 0 && model.spinnerCount === 0 &&
              h("div", {className: "ps-empty"}, "No permission sets or groups assigned to this user."),
            !user && model.spinnerCount === 0 && model.errorMessages.length === 0 &&
              h("div", {className: "ps-empty"}, "Loading user\u2026")
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
