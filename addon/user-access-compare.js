/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {PageHeader} from "./components/PageHeader.js";
import {UserInfoModel, copyToClipboard} from "./utils.js";
/* global initButton */

let h = React.createElement;

const ID_CHUNK = 150;
const USER_ID_RE = /^005[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/;
const RECORD_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

const SECTIONS = [
  {key: "assignments", label: "Profile, Permission Sets & Groups"},
  {key: "customPermissions", label: "Custom Permissions"},
  {key: "externalCredentials", label: "External Credential Principals"},
  {key: "objectCrud", label: "Object Permissions (CRUD)"},
  {key: "fieldFls", label: "Field Permissions (FLS)"},
  {key: "recordAccess", label: "Record Access (sharing)"},
];

const OBJECT_PERMS = [
  ["PermissionsRead", "Read"],
  ["PermissionsCreate", "Create"],
  ["PermissionsEdit", "Edit"],
  ["PermissionsDelete", "Delete"],
  ["PermissionsViewAllRecords", "View All"],
  ["PermissionsModifyAllRecords", "Modify All"],
];

const FIELD_PERMS = [
  ["PermissionsRead", "Read"],
  ["PermissionsEdit", "Edit"],
];

const RECORD_PERMS = [
  ["HasReadAccess", "Read"],
  ["HasEditAccess", "Edit"],
  ["HasDeleteAccess", "Delete"],
  ["HasTransferAccess", "Transfer"],
];

function soqlString(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function soqlLike(s) {
  return soqlString(s).replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function nowSoql() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
}

function sameId(a, b) {
  return !!a && !!b && a.substring(0, 15) === b.substring(0, 15);
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleString();
}

function dedupeSources(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s);
  }
  return out.sort((x, y) => x.label.localeCompare(y.label));
}

class Model {
  constructor(sfHost) {
    this.reactCallback = null;
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.title = "User Access Compare";
    this.errorMessages = [];
    this.warnings = [];

    this.inputs = {a: "", b: "", target: "", recordId: ""};
    this.users = {a: null, b: null};
    this.candidates = {a: [], b: []};

    this.rows = [];
    this.sectionsShown = [];
    this.compared = null;        // {target, recordId} of the last comparison
    this.hasCompared = false;
    this.running = false;
    this.onlyDiff = true;
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

  // ----- Query helpers -----

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

  /** Runs a query with an IN list, splitting the ids in chunks. buildSoql receives "'id1','id2'". */
  async queryIn(buildSoql, ids) {
    const out = [];
    for (const part of chunk(ids, ID_CHUNK)) {
      out.push(...await this.queryAll(buildSoql("'" + part.join("','") + "'")));
    }
    return out;
  }

  // ----- Users -----

  mapUser(r) {
    return {
      id: r.Id,
      name: r.Name,
      username: r.Username,
      isActive: !!r.IsActive,
      profile: (r.Profile && r.Profile.Name) || "",
      role: (r.UserRole && r.UserRole.Name) || "",
      license: (r.Profile && r.Profile.UserLicense && r.Profile.UserLicense.Name) || "",
    };
  }

  userSetupUrl(user) {
    return this.sfLink + "/lightning/setup/ManageUsers/page?address=%2F" + user.id + "%3Fnoredirect%3D1%26isUserEntityOverride%3D1";
  }

  /** Returns the user, or null when several candidates must be picked from. Throws when none is found. */
  async resolveUser(slot) {
    const raw = this.inputs[slot].trim();
    const label = "User " + slot.toUpperCase();
    if (!raw) throw new Error("Enter " + label + " (Id, Username or name).");
    const fields = "Id, Name, Username, IsActive, Profile.Name, UserRole.Name, Profile.UserLicense.Name";
    let where;
    if (USER_ID_RE.test(raw)) {
      where = "Id = '" + raw + "'";
    } else {
      where = "Username = '" + soqlString(raw) + "'"
        + " OR Name LIKE '%" + soqlLike(raw) + "%'"
        + " OR Username LIKE '%" + soqlLike(raw) + "%'";
    }
    const recs = await this.queryAll("SELECT " + fields + " FROM User WHERE " + where + " ORDER BY IsActive DESC, Name LIMIT 20");
    if (recs.length === 0) throw new Error(label + ": no user found for '" + raw + "'.");
    const lower = raw.toLowerCase();
    const exact = recs.filter(r => sameId(r.Id, raw) || (r.Username || "").toLowerCase() === lower);
    const pick = exact.length === 1 ? exact[0] : (recs.length === 1 ? recs[0] : null);
    if (pick) {
      const user = this.mapUser(pick);
      user.input = raw;
      return user;
    }
    this.candidates[slot] = recs.map(r => this.mapUser(r));
    return null;
  }

  pickCandidate(slot, user) {
    this.inputs[slot] = user.username;
    user.input = user.username;
    this.users[slot] = user;
    this.candidates[slot] = [];
    this.errorMessages = [];
    if (this.users.a && this.users.b) {
      this.compare();
    } else {
      this.didUpdate();
    }
  }

  setInput(key, value) {
    this.inputs[key] = value;
    if ((key === "a" || key === "b") && this.candidates[key].length) this.candidates[key] = [];
    this.didUpdate();
  }

  // ----- Compare -----

  parseTarget() {
    const t = this.inputs.target.trim();
    if (!t) return null;
    const parts = t.split(".");
    if (parts.length > 2 || !parts.every(p => API_NAME_RE.test(p))) {
      throw new Error("Enter the object as Object or Object.Field (e.g. Opportunity or Opportunity.StageName).");
    }
    return {object: parts[0], field: parts[1] || null};
  }

  parseRecordId() {
    const rid = this.inputs.recordId.trim();
    if (rid && !RECORD_ID_RE.test(rid)) throw new Error("The record Id must have 15 or 18 alphanumeric characters.");
    return rid;
  }

  async compare() {
    if (this.running) return;
    this.errorMessages = [];
    this.warnings = [];
    let target, recordId;
    try {
      target = this.parseTarget();
      recordId = this.parseRecordId();
    } catch (err) {
      this.errorMessages.push(err.message);
      this.didUpdate();
      return;
    }
    this.running = true;
    this.spinnerCount++;
    this.didUpdate();
    try {
      for (const slot of ["a", "b"]) {
        const current = this.users[slot];
        if (!current || current.input !== this.inputs[slot].trim()) {
          this.users[slot] = null;
          this.candidates[slot] = [];
          this.users[slot] = await this.resolveUser(slot);
        }
      }
      if (!this.users.a || !this.users.b) return; // candidates are shown, waiting for a pick
      if (sameId(this.users.a.id, this.users.b.id)) throw new Error("User A and User B are the same user.");
      await this.runCompare(target, recordId);
    } catch (err) {
      console.error(err);
      this.errorMessages.push(err.message);
    } finally {
      this.running = false;
      this.spinnerCount--;
      this.didUpdate();
    }
  }

  async loadAssignments(userIds) {
    const base = "SELECT AssigneeId, PermissionSetId, PermissionSetGroupId, ExpirationDate,"
      + " PermissionSet.Name, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.ProfileId, PermissionSet.Profile.Name,"
      + " PermissionSetGroup.DeveloperName, PermissionSetGroup.MasterLabel, PermissionSetGroup.Status"
      + " FROM PermissionSetAssignment WHERE AssigneeId IN ('" + userIds.join("','") + "')";
    try {
      return await this.queryAll(base + " AND IsActive = true AND (ExpirationDate = null OR ExpirationDate > " + nowSoql() + ")");
    } catch (err) {
      console.warn("Filtered assignment query failed, retrying without IsActive filter", err);
      this.warnings.push("Assignments could not be filtered by IsActive (" + err.message + "). Expired assignments are removed, but inactive ones may appear.");
      const recs = await this.queryAll(base);
      const now = Date.now();
      return recs.filter(r => !r.ExpirationDate || new Date(r.ExpirationDate).getTime() > now);
    }
  }

  sourceFromAssignment(r) {
    const ps = r.PermissionSet || {};
    if (ps.IsOwnedByProfile) {
      return {
        key: "profile:" + ps.ProfileId,
        kind: "Profile",
        label: (ps.Profile && ps.Profile.Name) || ps.Label || "(profile)",
        apiName: "",
        url: this.sfLink + "/lightning/setup/EnhancedProfiles/page?address=%2F" + ps.ProfileId,
        expiration: r.ExpirationDate || null,
      };
    }
    if (r.PermissionSetGroupId) {
      const g = r.PermissionSetGroup || {};
      return {
        key: "psg:" + r.PermissionSetGroupId,
        kind: "Permission Set Group",
        label: g.MasterLabel || g.DeveloperName || ps.Label || "(permission set group)",
        apiName: g.DeveloperName || "",
        status: g.Status || "",
        url: this.sfLink + "/lightning/setup/PermSetGroups/page?address=%2F" + r.PermissionSetGroupId,
        expiration: r.ExpirationDate || null,
      };
    }
    return {
      key: "ps:" + r.PermissionSetId,
      kind: "Permission Set",
      label: ps.Label || ps.Name || "(permission set)",
      apiName: ps.Name || "",
      url: this.sfLink + "/lightning/setup/PermSets/page?address=%2F" + r.PermissionSetId,
      expiration: r.ExpirationDate || null,
    };
  }

  async runCompare(target, recordId) {
    const A = this.users.a;
    const B = this.users.b;
    const rows = [];
    const sectionsShown = ["assignments", "customPermissions", "externalCredentials"];

    // 1. Assignments (profile + permission sets + groups), active and not expired
    const psa = await this.loadAssignments([A.id, B.id]);
    const perUser = {a: new Map(), b: new Map()}; // PermissionSetId -> source
    for (const r of psa) {
      const slot = sameId(r.AssigneeId, A.id) ? "a" : "b";
      perUser[slot].set(r.PermissionSetId, this.sourceFromAssignment(r));
    }

    const byKey = new Map();
    for (const slot of ["a", "b"]) {
      for (const src of perUser[slot].values()) {
        if (!byKey.has(src.key)) byKey.set(src.key, {src, a: null, b: null});
        byKey.get(src.key)[slot] = src;
      }
    }
    const warnedGroups = new Set();
    for (const {src, a, b} of byKey.values()) {
      if (src.status && src.status !== "Updated" && !warnedGroups.has(src.key)) {
        warnedGroups.add(src.key);
        this.warnings.push("Permission set group '" + src.label + "' has status '" + src.status + "': its calculated permissions may be outdated.");
      }
      rows.push({
        section: "assignments",
        item: src.label,
        itemUrl: src.url,
        detail: src.kind + (src.apiName && src.apiName !== src.label ? " · " + src.apiName : ""),
        order: src.kind === "Profile" ? 0 : (src.kind === "Permission Set Group" ? 1 : 2),
        a: {has: !!a, note: a && a.expiration ? "Expires " + formatDate(a.expiration) : "", sources: []},
        b: {has: !!b, note: b && b.expiration ? "Expires " + formatDate(b.expiration) : "", sources: []},
      });
    }

    const allParentIds = Array.from(new Set([...perUser.a.keys(), ...perUser.b.keys()]));
    const sourcesFor = (slot, parentIds) => dedupeSources(parentIds.filter(id => perUser[slot].has(id)).map(id => perUser[slot].get(id)));

    // 2. Custom permissions and external credential principals
    let sea = [];
    if (allParentIds.length) {
      try {
        sea = await this.queryIn(list => "SELECT ParentId, SetupEntityId, SetupEntityType FROM SetupEntityAccess"
          + " WHERE SetupEntityType IN ('CustomPermission','ExternalCredentialParameter') AND ParentId IN (" + list + ")", allParentIds);
      } catch (err) {
        console.error(err);
        this.warnings.push("Could not load custom permissions / external credential access: " + err.message);
      }
    }
    const cpIds = Array.from(new Set(sea.filter(r => r.SetupEntityType === "CustomPermission").map(r => r.SetupEntityId)));
    const ecpIds = Array.from(new Set(sea.filter(r => r.SetupEntityType === "ExternalCredentialParameter").map(r => r.SetupEntityId)));

    const cpInfo = new Map();
    if (cpIds.length) {
      try {
        const recs = await this.queryIn(list => "SELECT Id, DeveloperName, MasterLabel, NamespacePrefix FROM CustomPermission WHERE Id IN (" + list + ")", cpIds);
        for (const r of recs) {
          const apiName = r.NamespacePrefix ? r.NamespacePrefix + "__" + r.DeveloperName : r.DeveloperName;
          cpInfo.set(r.Id, {
            item: r.MasterLabel || apiName,
            detail: apiName,
            url: this.sfLink + "/lightning/setup/CustomPermissions/page?address=%2F" + r.Id,
          });
        }
      } catch (err) {
        console.error(err);
        this.warnings.push("Could not load custom permission names: " + err.message);
      }
    }

    const ecpInfo = new Map();
    if (ecpIds.length) {
      try {
        const recs = await this.queryIn(list => "SELECT Id, ParameterName, ParameterType, ExternalCredential.DeveloperName, ExternalCredential.MasterLabel"
          + " FROM ExternalCredentialParameter WHERE Id IN (" + list + ")", ecpIds);
        for (const r of recs) {
          const ec = r.ExternalCredential || {};
          ecpInfo.set(r.Id, {
            item: (ec.MasterLabel || ec.DeveloperName || "(external credential)") + " › " + (r.ParameterName || r.Id),
            detail: (ec.DeveloperName || "") + (r.ParameterType ? " · " + r.ParameterType : ""),
            url: "",
          });
        }
      } catch (err) {
        console.error(err);
        this.warnings.push("Could not load external credential principal names: " + err.message);
      }
    }

    const addEntityRows = (section, type, info) => {
      const grouped = new Map(); // entityId -> [parentIds]
      for (const r of sea) {
        if (r.SetupEntityType !== type) continue;
        if (!grouped.has(r.SetupEntityId)) grouped.set(r.SetupEntityId, []);
        grouped.get(r.SetupEntityId).push(r.ParentId);
      }
      for (const [entityId, parentIds] of grouped) {
        const meta = info.get(entityId) || {item: entityId, detail: "", url: ""};
        const aSources = sourcesFor("a", parentIds);
        const bSources = sourcesFor("b", parentIds);
        rows.push({
          section,
          item: meta.item,
          itemUrl: meta.url,
          detail: meta.detail,
          order: 0,
          a: {has: aSources.length > 0, note: "", sources: aSources},
          b: {has: bSources.length > 0, note: "", sources: bSources},
        });
      }
    };
    addEntityRows("customPermissions", "CustomPermission", cpInfo);
    addEntityRows("externalCredentials", "ExternalCredentialParameter", ecpInfo);

    // 3. Object CRUD and field FLS
    let targetLabel = null;
    if (target) {
      let describe;
      try {
        describe = await sfConn.rest("/services/data/v" + apiVersion + "/sobjects/" + encodeURIComponent(target.object) + "/describe");
      } catch (err) {
        throw new Error("Object '" + target.object + "' was not found or is not accessible: " + err.message);
      }
      const objName = describe.name;
      let fieldName = null;
      if (target.field) {
        const f = (describe.fields || []).find(x => x.name.toLowerCase() === target.field.toLowerCase());
        if (!f) throw new Error("Field '" + target.field + "' was not found on " + objName + ".");
        fieldName = f.name;
        if (f.permissionable === false) {
          this.warnings.push(objName + "." + fieldName + " is not permission-controlled (required or system field): its access follows the object's Read permission.");
        }
      }
      targetLabel = fieldName ? objName + "." + fieldName : objName;
      sectionsShown.push("objectCrud");

      let op = [];
      if (allParentIds.length) {
        op = await this.queryIn(list => "SELECT ParentId, " + OBJECT_PERMS.map(p => p[0]).join(", ")
          + " FROM ObjectPermissions WHERE SobjectType = '" + soqlString(objName) + "' AND ParentId IN (" + list + ")", allParentIds);
      }
      OBJECT_PERMS.forEach(([fieldKey, label], idx) => {
        const parentIds = op.filter(r => r[fieldKey]).map(r => r.ParentId);
        const aSources = sourcesFor("a", parentIds);
        const bSources = sourcesFor("b", parentIds);
        rows.push({
          section: "objectCrud",
          item: label,
          itemUrl: "",
          detail: objName,
          order: idx,
          a: {has: aSources.length > 0, note: "", sources: aSources},
          b: {has: bSources.length > 0, note: "", sources: bSources},
        });
      });

      if (fieldName) {
        sectionsShown.push("fieldFls");
        let fp = [];
        if (allParentIds.length) {
          fp = await this.queryIn(list => "SELECT ParentId, PermissionsRead, PermissionsEdit FROM FieldPermissions"
            + " WHERE SobjectType = '" + soqlString(objName) + "' AND Field = '" + soqlString(objName + "." + fieldName) + "'"
            + " AND ParentId IN (" + list + ")", allParentIds);
        }
        FIELD_PERMS.forEach(([fieldKey, label], idx) => {
          const parentIds = fp.filter(r => r[fieldKey]).map(r => r.ParentId);
          const aSources = sourcesFor("a", parentIds);
          const bSources = sourcesFor("b", parentIds);
          rows.push({
            section: "fieldFls",
            item: label,
            itemUrl: "",
            detail: objName + "." + fieldName,
            order: idx,
            a: {has: aSources.length > 0, note: "", sources: aSources},
            b: {has: bSources.length > 0, note: "", sources: bSources},
          });
        });
      }
    }

    // 4. Record access (sharing)
    if (recordId) {
      sectionsShown.push("recordAccess");
      const access = {a: null, b: null};
      for (const slot of ["a", "b"]) {
        const user = this.users[slot];
        try {
          const recs = await this.queryAll("SELECT RecordId, HasReadAccess, HasEditAccess, HasDeleteAccess, HasTransferAccess, MaxAccessLevel"
            + " FROM UserRecordAccess WHERE UserId = '" + user.id + "' AND RecordId = '" + recordId + "'");
          access[slot] = recs[0] || null;
          if (!recs[0]) this.warnings.push("No record access information returned for " + user.name + " on " + recordId + " (check the Id).");
        } catch (err) {
          console.error(err);
          this.warnings.push("Could not check record access for " + user.name + ": " + err.message);
        }
      }
      if (access.a || access.b) {
        RECORD_PERMS.forEach(([fieldKey, label], idx) => {
          rows.push({
            section: "recordAccess",
            item: label,
            itemUrl: "",
            detail: recordId,
            order: idx,
            a: {has: !!(access.a && access.a[fieldKey]), note: "", sources: []},
            b: {has: !!(access.b && access.b[fieldKey]), note: "", sources: []},
          });
        });
        rows.push({
          section: "recordAccess",
          item: "Max Access Level",
          itemUrl: "",
          detail: recordId,
          order: RECORD_PERMS.length,
          compareText: true,
          a: {has: !!access.a, text: (access.a && access.a.MaxAccessLevel) || "—", note: "", sources: []},
          b: {has: !!access.b, text: (access.b && access.b.MaxAccessLevel) || "—", note: "", sources: []},
        });
      }
    }

    for (const row of rows) {
      row.diff = row.compareText ? row.a.text !== row.b.text : row.a.has !== row.b.has;
    }
    const sectionIndex = key => SECTIONS.findIndex(s => s.key === key);
    const fixedOrder = ["objectCrud", "fieldFls", "recordAccess"];
    rows.sort((x, y) => sectionIndex(x.section) - sectionIndex(y.section)
      || x.order - y.order
      || (fixedOrder.includes(x.section) ? 0 : x.item.localeCompare(y.item)));

    this.rows = rows;
    this.sectionsShown = sectionsShown;
    this.compared = {target: targetLabel, recordId};
    this.hasCompared = true;
    this.filter = "";
  }

  // ----- View helpers -----

  visibleRows() {
    const f = this.filter.trim().toLowerCase();
    return this.rows.filter(row => {
      if (this.onlyDiff && !row.diff) return false;
      if (!f) return true;
      const hay = [row.item, row.detail]
        .concat(row.a.sources.map(s => s.label), row.b.sources.map(s => s.label))
        .join(" ").toLowerCase();
      return hay.includes(f);
    });
  }

  sideValue(side, row) {
    if (row.compareText) return side.text;
    return side.has ? "Yes" : "No";
  }

  copyAsCsv() {
    const header = ["Section", "Item", "Detail", "User A", "User B", "Granted by (A)", "Granted by (B)", "Different"];
    const lines = this.visibleRows().map(row => [
      SECTIONS.find(s => s.key === row.section).label,
      row.item,
      row.detail,
      this.sideValue(row.a, row),
      this.sideValue(row.b, row),
      row.a.sources.map(s => s.label).join("; "),
      row.b.sources.map(s => s.label).join("; "),
      row.diff ? "Yes" : "No",
    ].map(csvCell).join(","));
    copyToClipboard([header.join(",")].concat(lines).join("\n"));
  }

  copyAsJson() {
    const strip = u => ({id: u.id, name: u.name, username: u.username, isActive: u.isActive, profile: u.profile, role: u.role, license: u.license});
    const data = {
      userA: strip(this.users.a),
      userB: strip(this.users.b),
      target: this.compared.target,
      recordId: this.compared.recordId || null,
      rows: this.visibleRows().map(row => ({
        section: row.section,
        item: row.item,
        detail: row.detail,
        userA: this.sideValue(row.a, row),
        userB: this.sideValue(row.b, row),
        grantedByA: row.a.sources.map(s => s.kind + ": " + s.label),
        grantedByB: row.b.sources.map(s => s.kind + ": " + s.label),
        different: row.diff,
      })),
    };
    copyToClipboard(JSON.stringify(data, null, 2));
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onCompare = this.onCompare.bind(this);
    this.onFilter = this.onFilter.bind(this);
    this.onToggleDiff = this.onToggleDiff.bind(this);
    this.onCopyCsv = this.onCopyCsv.bind(this);
    this.onCopyJson = this.onCopyJson.bind(this);
  }

  onKeyDown(e) { if (e.key === "Enter") { e.preventDefault(); this.onCompare(); } }
  onCompare() { this.props.vm.compare(); }
  onFilter(e) { this.props.vm.filter = e.target.value; this.props.vm.didUpdate(); }
  onToggleDiff(e) { this.props.vm.onlyDiff = e.target.checked; this.props.vm.didUpdate(); }
  onCopyCsv() { this.props.vm.copyAsCsv(); }
  onCopyJson() { this.props.vm.copyAsJson(); }

  renderInput(key, label, placeholder, flex) {
    const model = this.props.vm;
    return h("div", {className: "slds-form-element uac-input", style: {flex}},
      h("label", {className: "slds-form-element__label"}, label),
      h("div", {className: "slds-form-element__control"},
        h("input", {
          type: "search",
          className: "slds-input",
          placeholder,
          value: model.inputs[key],
          onChange: e => model.setInput(key, e.target.value),
          onKeyDown: this.onKeyDown,
        })
      ),
      (key === "a" || key === "b") && model.candidates[key].length > 0 && this.renderCandidates(key)
    );
  }

  renderCandidates(slot) {
    const model = this.props.vm;
    return h("div", {className: "uac-candidates"},
      h("div", {className: "uac-candidates-title"}, "Several users match — pick one:"),
      model.candidates[slot].map(u =>
        h("div", {key: u.id, className: "uac-candidate", onClick: () => model.pickCandidate(slot, u)},
          h("div", {}, h("strong", {}, u.name), !u.isActive && h("span", {className: "slds-badge uac-badge-inactive slds-m-left_x-small"}, "Inactive")),
          h("div", {className: "uac-sub"}, u.username + (u.profile ? " · " + u.profile : ""))
        )
      )
    );
  }

  renderUserCard(slot) {
    const model = this.props.vm;
    const u = model.users[slot];
    if (!u) return null;
    return h("div", {className: "uac-user-card"},
      h("div", {className: "uac-user-slot"}, "User " + slot.toUpperCase()),
      h("div", {className: "slds-text-heading_small"},
        h("a", {href: model.userSetupUrl(u), target: "_blank", title: "Open user in Setup"}, u.name),
        h("span", {className: "slds-badge slds-m-left_x-small " + (u.isActive ? "uac-badge-yes" : "uac-badge-inactive")}, u.isActive ? "Active" : "Inactive")
      ),
      h("div", {className: "uac-sub"}, u.username),
      h("dl", {className: "uac-user-meta"},
        h("dt", {}, "Profile"), h("dd", {}, u.profile || "—"),
        h("dt", {}, "Role"), h("dd", {}, u.role || "—"),
        h("dt", {}, "License"), h("dd", {}, u.license || "—")
      )
    );
  }

  renderCell(side, row) {
    if (row.compareText) {
      return h("span", {className: "uac-text-value"}, side.text);
    }
    return h("div", {},
      h("span", {className: "slds-badge " + (side.has ? "uac-badge-yes" : "uac-badge-no")}, side.has ? "✓ Yes" : "✗ No"),
      side.note && h("div", {className: "uac-sub"}, side.note),
      side.sources.length > 0 && h("div", {className: "uac-sources"},
        side.sources.map(s =>
          h("div", {key: s.key, className: "uac-source"},
            h("span", {className: "uac-kind"}, s.kind === "Profile" ? "Profile" : (s.kind === "Permission Set Group" ? "PSG" : "PS")),
            h("a", {href: s.url, target: "_blank", title: "Open in Setup"}, s.label)
          )
        )
      )
    );
  }

  renderSection(section, rows) {
    const model = this.props.vm;
    const all = model.rows.filter(r => r.section === section.key);
    const diffCount = all.filter(r => r.diff).length;
    return h("div", {key: section.key, className: "slds-m-bottom_medium"},
      h("h3", {className: "slds-text-heading_small uac-section-title"},
        section.label,
        h("span", {className: "uac-count"}, diffCount + " difference(s) · " + all.length + " item(s)")
      ),
      all.length === 0
        ? h("div", {className: "uac-empty-small"}, "Neither user has anything in this section.")
        : rows.length === 0
          ? h("div", {className: "uac-empty-small"}, model.onlyDiff && !model.filter ? "No differences." : "No rows match the filter.")
          : h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered uac-table"},
            h("thead", {},
              h("tr", {className: "slds-line-height_reset"},
                h("th", {style: {width: "34%"}}, "Item"),
                h("th", {style: {width: "33%"}}, "User A · " + model.users.a.name),
                h("th", {style: {width: "33%"}}, "User B · " + model.users.b.name)
              )
            ),
            h("tbody", {},
              rows.map((row, idx) =>
                h("tr", {key: section.key + "_" + idx, className: row.diff ? "uac-diff" : ""},
                  h("td", {},
                    row.itemUrl
                      ? h("a", {href: row.itemUrl, target: "_blank", title: "Open in Setup"}, row.item)
                      : h("span", {}, row.item),
                    row.detail && h("div", {className: "uac-sub"}, row.detail)
                  ),
                  h("td", {}, this.renderCell(row.a, row)),
                  h("td", {}, this.renderCell(row.b, row))
                )
              )
            )
          )
    );
  }

  render() {
    const model = this.props.vm;
    document.title = model.title;
    const visible = model.hasCompared ? model.visibleRows() : [];
    const totalDiff = model.rows.filter(r => r.diff).length;
    return h("div", {},
      h(PageHeader, {
        pageTitle: "User Access Compare",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        ...model.userInfoModel.getProps()
      }),
      h("div", {className: "slds-m-top_xx-large sfir-page-container"},
        h("div", {className: "slds-card slds-m-around_medium", style: {flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0}},
          h("div", {className: "slds-card__header slds-p-horizontal_small slds-p-top_small uac-form"},
            h("div", {className: "uac-row"},
              this.renderInput("a", "User A", "Id, Username or name", "1"),
              this.renderInput("b", "User B", "Id, Username or name", "1")
            ),
            h("div", {className: "uac-row"},
              this.renderInput("target", "Object or Object.Field (optional)", "e.g. Order or Order.IsPendingBaja__c", "2"),
              this.renderInput("recordId", "Record Id (optional)", "Checks sharing access to this record", "1"),
              h("div", {className: "uac-button-cell"},
                h("button", {className: "slds-button slds-button_brand", disabled: model.running, onClick: this.onCompare}, model.running ? "Comparing…" : "Compare")
              )
            )
          ),
          h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1", overflowY: "auto", minHeight: 0}},
            model.errorMessages.length > 0
              && h("div", {className: "slds-notify slds-notify_alert slds-theme_error slds-m-bottom_small", role: "alert"},
                model.errorMessages[model.errorMessages.length - 1]),
            model.warnings.map((w, i) =>
              h("div", {key: "w" + i, className: "slds-notify slds-notify_alert slds-theme_warning slds-m-bottom_x-small", role: "alert"}, w)),
            !model.hasCompared && h("div", {className: "uac-empty"},
              "Enter two users and press Compare to see the differences in profile, permission sets and groups, custom permissions and external credential principals. "
              + "Add an object or Object.Field to compare CRUD and FLS, and a record Id to compare sharing access."),
            model.hasCompared && h("div", {},
              h("div", {className: "uac-cards"}, this.renderUserCard("a"), this.renderUserCard("b")),
              h("div", {className: "uac-toolbar"},
                h("div", {className: "uac-summary"},
                  h("strong", {}, totalDiff + " difference(s)"),
                  " out of " + model.rows.length + " item(s)",
                  model.compared.target && h("span", {}, " · ", h("code", {}, model.compared.target)),
                  model.compared.recordId && h("span", {}, " · record ", h("code", {}, model.compared.recordId))
                ),
                h("div", {className: "uac-toolbar-actions"},
                  h("label", {className: "uac-checkbox"},
                    h("input", {type: "checkbox", checked: model.onlyDiff, onChange: this.onToggleDiff}),
                    " Only differences"
                  ),
                  h("input", {
                    type: "search",
                    className: "slds-input uac-filter-input",
                    placeholder: "Filter by item or source",
                    value: model.filter,
                    onChange: this.onFilter,
                  }),
                  h("button", {className: "slds-button slds-button_neutral", disabled: visible.length === 0, onClick: this.onCopyCsv, title: "Copy visible rows as CSV"}, "Copy CSV"),
                  h("button", {className: "slds-button slds-button_neutral", disabled: visible.length === 0, onClick: this.onCopyJson, title: "Copy visible rows as JSON"}, "Copy JSON")
                )
              ),
              SECTIONS.filter(s => model.sectionsShown.includes(s.key))
                .map(s => this.renderSection(s, visible.filter(r => r.section === s.key))),
              h("p", {className: "uac-footnote"},
                "Note: system permissions such as View All Data or Modify All Data also grant object access and are not included in this comparison.")
            )
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
