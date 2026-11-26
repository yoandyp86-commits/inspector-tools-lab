/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {PageHeader} from "./components/PageHeader.js";
import {UserInfoModel, copyToClipboard} from "./utils.js";
/* global initButton */

let h = React.createElement;
const SEARCH_LIMIT = 50;
const ID_CHUNK = 150;
const USAGE_LIMIT = 2000;
const COMPOSITE_SIZE = 25;
const MATCH_MAX = 200;

const TABS = [
  {id: "profiles", label: "Profiles"},
  {id: "permSets", label: "Permission Sets"},
  {id: "groups", label: "Permission Set Groups"},
  {id: "users", label: "Users"},
  {id: "validation", label: "Validation Rules"},
  {id: "code", label: "Code"},
  {id: "usage", label: "Usage"},
];
const SECTION_IDS = TABS.map(t => t.id);

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
}

function escapeLike(text) {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

function apiNameOf(ns, name) {
  return ns ? ns + "__" + name : name;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex for "<prefix><CP API name>" not followed by another identifier character. */
function cpRegex(prefixPattern, apiName, global) {
  return new RegExp(prefixPattern + escapeRegex(apiName) + "(?![A-Za-z0-9_])", global ? "gi" : "i");
}
const PERMISSION_PREFIX = "\\$Permission\\.";
const LWC_PREFIX = "@salesforce/customPermission/";

/** Lines of a source that match the regex: [{line, text}]. */
function matchLines(source, regex) {
  const out = [];
  if (!source || !regex.test(source)) return out;
  source.split(/\r?\n/).forEach((text, i) => {
    if (regex.test(text)) {
      const t = text.trim();
      out.push({line: i + 1, text: t.length > MATCH_MAX ? t.slice(0, MATCH_MAX) + "\u2026" : t});
    }
  });
  return out;
}

function statusBadgeClass(status) {
  if (status === "Updated") return "wc-badge-on";
  if (status === "Failed") return "wc-badge-error";
  if (status === "Outdated" || status === "Updating") return "wc-badge-warn";
  return "wc-badge-off";
}

function emptySection() {
  return {status: "idle", rows: [], error: ""};
}

class Model {
  constructor(sfHost) {
    this.reactCallback = null;
    this.sfHost = sfHost;
    this.sfLink = "https://" + sfHost;
    this.orgName = sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;
    this.title = "Where is CP";
    this.errorMessages = [];

    // Search (same behaviour as Field Permissions)
    this.searchResults = [];
    this.searchedQuery = "";
    this.searchDone = false;
    this.searchHasMore = false;
    this.resultsVisible = false;
    this.searchSeq = 0;

    // Selected custom permission and its results
    this.selectedCP = null;   // {Id, DeveloperName, MasterLabel, NamespacePrefix, Description}
    this.loadSeq = 0;         // ignores results of a previous selection
    this.activeTab = "profiles";
    // Org-wide scans, independent of the selected CP: loaded once per session
    this.vrCache = null;      // Promise<{rules, failed}>
    this.codeCache = null;    // Promise<{files, failedTypes}>
    this.resetResults();

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

  resetResults() {
    this.sections = {};
    this.filters = {};
    SECTION_IDS.forEach(id => { this.sections[id] = emptySection(); this.filters[id] = ""; });
    this.activeOnly = true;
    this.activeRulesOnly = false;
    this.expanded = {};
    this.usageType = "";
    this.warnings = [];
    this.soqlLog = [];
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

  // ----- Queries -----

  logSoql(soql, tooling) {
    const entry = (tooling ? "-- Tooling API\n" : "") + soql;
    if (!this.soqlLog.includes(entry)) this.soqlLog.push(entry);
  }

  async queryAll(soql, tooling = false) {
    this.logSoql(soql, tooling);
    let url = "/services/data/v" + apiVersion + (tooling ? "/tooling" : "") + "/query/?q=" + encodeURIComponent(soql);
    const out = [];
    while (url) {
      const res = await sfConn.rest(url);
      out.push(...(res.records || []));
      url = res.nextRecordsUrl || null;
    }
    return out;
  }

  /** Runs a query with an IN list, split in chunks. buildSoql receives "'id1','id2'". */
  async queryIn(buildSoql, ids) {
    const out = [];
    for (const part of chunk(ids, ID_CHUNK)) {
      out.push(...await this.queryAll(buildSoql("'" + part.join("','") + "'")));
    }
    return out;
  }

  // ----- Search -----

  runSearch(query) {
    query = query.trim();
    if (!query) return;
    const like = "'%" + escapeLike(query) + "%'";
    const soql = "SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, Description"
      + " FROM CustomPermission WHERE MasterLabel LIKE " + like + " OR DeveloperName LIKE " + like
      + " ORDER BY MasterLabel LIMIT " + (SEARCH_LIMIT + 1);
    const seq = ++this.searchSeq;
    this.errorMessages = [];
    this.didUpdate();
    const promise = sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
    this.spinFor("searching custom permissions", promise, (res) => {
      if (seq !== this.searchSeq) return;
      const rows = res.records || [];
      this.searchHasMore = rows.length > SEARCH_LIMIT;
      this.searchResults = rows.slice(0, SEARCH_LIMIT);
      this.searchedQuery = query;
      this.searchDone = true;
      this.resultsVisible = true;
    });
  }

  showResults() { this.resultsVisible = true; this.didUpdate(); }
  hideResults() { this.resultsVisible = false; this.didUpdate(); }

  selectCP(cp) {
    this.selectedCP = cp;
    this.resultsVisible = false;
    this.errorMessages = [];
    this.activeTab = "profiles";
    this.resetResults();
    this.didUpdate();
    this.loadAll(cp);
  }

  setTab(id) { this.activeTab = id; this.didUpdate(); }

  toggleExpanded(id) { this.expanded[id] = !this.expanded[id]; this.didUpdate(); }

  // ----- Loading -----

  setSection(name, patch) {
    this.sections[name] = Object.assign({}, this.sections[name], patch);
    this.didUpdate();
  }

  async loadAll(cp) {
    const seq = ++this.loadSeq;
    const alive = () => seq === this.loadSeq;
    SECTION_IDS.forEach(s => { this.sections[s].status = "loading"; });
    this.spinnerCount++;
    this.didUpdate();
    try {
      await Promise.all([
        this.loadAssignments(cp, alive),
        this.loadUsage(cp, alive),
        this.loadValidation(cp, alive),
        this.loadCode(cp, alive),
      ]);
    } finally {
      this.spinnerCount--;
      this.didUpdate();
    }
  }

  async loadAssignments(cp, alive) {
    // 1. Profiles and permission sets that contain the custom permission
    let profiles = [];
    let permSets = [];
    const effectiveGroups = {}; // PermissionSetGroupId -> {session}
    try {
      const sea = await this.queryAll("SELECT ParentId, Parent.Name, Parent.Label, Parent.Type, Parent.NamespacePrefix,"
        + " Parent.IsOwnedByProfile, Parent.ProfileId, Parent.Profile.Name, Parent.PermissionSetGroupId,"
        + " Parent.HasActivationRequired"
        + " FROM SetupEntityAccess WHERE SetupEntityType = 'CustomPermission' AND SetupEntityId = '" + cp.Id + "'");
      if (!alive()) return;
      for (const r of sea) {
        const p = r.Parent || {};
        if (p.IsOwnedByProfile) {
          profiles.push({
            psId: r.ParentId,
            profileId: p.ProfileId,
            name: (p.Profile && p.Profile.Name) || p.Label || "(unknown profile)",
            link: this.sfLink + "/lightning/setup/EnhancedProfiles/page?address=%2F" + p.ProfileId,
          });
        } else if (p.PermissionSetGroupId) {
          // Aggregate permission set of a group: permissions already calculated (muting applied)
          effectiveGroups[p.PermissionSetGroupId] = {session: !!p.HasActivationRequired};
        } else if (p.Type !== "Muting") {
          permSets.push({
            id: r.ParentId,
            label: p.Label || p.Name,
            apiName: apiNameOf(p.NamespacePrefix, p.Name),
            license: "",
            session: !!p.HasActivationRequired,
            link: this.sfLink + "/lightning/setup/PermSets/page?address=%2F" + r.ParentId,
          });
        }
      }
      profiles.sort((a, b) => a.name.localeCompare(b.name));
      permSets.sort((a, b) => a.label.localeCompare(b.label));
      this.setSection("profiles", {status: "done", rows: profiles});
      this.setSection("permSets", {status: "done", rows: permSets});
    } catch (err) {
      console.error(err);
      if (!alive()) return;
      const error = "Error loading assignments: " + err.message;
      ["profiles", "permSets", "groups", "users"].forEach(s => this.setSection(s, {status: "error", error}));
      return;
    }

    // 1b. License of each permission set (optional: blank if the query fails)
    if (permSets.length) {
      try {
        const lic = await this.queryIn(list => "SELECT Id, License.Name FROM PermissionSet WHERE Id IN (" + list + ")",
          permSets.map(p => p.id));
        if (!alive()) return;
        const byId = {};
        lic.forEach(r => { byId[r.Id] = r.License && r.License.Name; });
        permSets = permSets.map(p => Object.assign({}, p, {license: byId[p.id] || ""}));
        this.setSection("permSets", {rows: permSets});
      } catch (err) {
        console.warn("License query failed", err);
        if (!alive()) return;
        this.warnings.push("Permission set licenses could not be loaded (" + err.message + ").");
      }
    }

    // 2. Permission set groups: effective ones (aggregate rows above) plus groups that contain
    //    a permission set with the CP but do not grant it (muted or not recalculated)
    let groups = [];
    try {
      const viaByGroup = {};
      if (permSets.length) {
        const comps = await this.queryIn(list => "SELECT PermissionSetGroupId, PermissionSetId, PermissionSet.Label"
          + " FROM PermissionSetGroupComponent WHERE PermissionSetId IN (" + list + ")", permSets.map(p => p.id));
        if (!alive()) return;
        for (const r of comps) {
          const psLabel = (r.PermissionSet && r.PermissionSet.Label) || r.PermissionSetId;
          const list = viaByGroup[r.PermissionSetGroupId] || (viaByGroup[r.PermissionSetGroupId] = []);
          if (!list.includes(psLabel)) list.push(psLabel);
        }
      }
      const groupIds = Object.keys(effectiveGroups);
      Object.keys(viaByGroup).forEach(id => { if (!groupIds.includes(id)) groupIds.push(id); });
      if (groupIds.length) {
        const psg = await this.queryIn(list => "SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, Status"
          + " FROM PermissionSetGroup WHERE Id IN (" + list + ")", groupIds);
        if (!alive()) return;
        groups = psg.map(g => ({
          id: g.Id,
          label: g.MasterLabel || g.DeveloperName,
          apiName: apiNameOf(g.NamespacePrefix, g.DeveloperName),
          status: g.Status || "",
          granted: !!effectiveGroups[g.Id],
          session: !!(effectiveGroups[g.Id] && effectiveGroups[g.Id].session),
          viaPS: viaByGroup[g.Id] || [],
          link: this.sfLink + "/lightning/setup/PermSetGroups/page?address=%2F" + g.Id,
        })).sort((a, b) => (b.granted - a.granted) || a.label.localeCompare(b.label));
      }
      this.setSection("groups", {status: "done", rows: groups});
    } catch (err) {
      console.error(err);
      if (!alive()) return;
      this.setSection("groups", {status: "error", error: "Error loading permission set groups: " + err.message});
    }

    // 3. Users who receive the custom permission through any of the above
    try {
      const base = "SELECT AssigneeId, Assignee.Name, Assignee.Username, Assignee.IsActive, Assignee.Profile.Name,"
        + " PermissionSetId, PermissionSet.IsOwnedByProfile, PermissionSet.Label, PermissionSet.Profile.Name,"
        + " PermissionSetGroupId, PermissionSetGroup.MasterLabel, ExpirationDate"
        + " FROM PermissionSetAssignment WHERE ";
      const psIds = profiles.map(p => p.psId).concat(permSets.map(p => p.id));
      const recs = [];
      if (psIds.length) recs.push(...await this.queryIn(list => base + "PermissionSetId IN (" + list + ")", psIds));
      const grantingGroups = groups.filter(g => g.granted).map(g => g.id);
      if (grantingGroups.length) recs.push(...await this.queryIn(list => base + "PermissionSetGroupId IN (" + list + ")", grantingGroups));
      if (!alive()) return;
      this.setSection("users", {status: "done", rows: this.buildUsers(recs)});
    } catch (err) {
      console.error(err);
      if (!alive()) return;
      this.setSection("users", {status: "error", error: "Error loading users: " + err.message});
    }
  }

  buildUsers(recs) {
    const now = Date.now();
    const byUser = {};
    for (const r of recs) {
      // Expired assignments no longer grant the permission
      if (r.ExpirationDate && new Date(r.ExpirationDate).getTime() <= now) continue;
      const a = r.Assignee || {};
      if (!byUser[r.AssigneeId]) {
        byUser[r.AssigneeId] = {
          id: r.AssigneeId,
          name: a.Name || r.AssigneeId,
          username: a.Username || "",
          profile: (a.Profile && a.Profile.Name) || "",
          active: !!a.IsActive,
          vias: [],
          link: this.sfLink + "/lightning/setup/ManageUsers/page?address=%2F" + r.AssigneeId
            + "%3Fnoredirect%3D1%26isUserEntityOverride%3D1",
        };
      }
      const ps = r.PermissionSet || {};
      let via;
      if (r.PermissionSetGroupId) {
        via = {kind: "PSG", name: (r.PermissionSetGroup && r.PermissionSetGroup.MasterLabel) || r.PermissionSetGroupId};
      } else if (ps.IsOwnedByProfile) {
        via = {kind: "Profile", name: (ps.Profile && ps.Profile.Name) || ps.Label || ""};
      } else {
        via = {kind: "PS", name: ps.Label || r.PermissionSetId};
      }
      via.expiration = r.ExpirationDate || null;
      const user = byUser[r.AssigneeId];
      if (!user.vias.some(v => v.kind === via.kind && v.name === via.name)) user.vias.push(via);
    }
    return Object.keys(byUser).map(k => {
      const u = byUser[k];
      // Access ends with the last expiring assignment; never if any assignment has no expiration
      const neverExpires = u.vias.some(v => !v.expiration);
      u.expiration = neverExpires ? "" : u.vias.map(v => v.expiration).sort().pop();
      return u;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async loadUsage(cp, alive) {
    try {
      const recs = await this.queryAll("SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType,"
        + " MetadataComponentNamespace FROM MetadataComponentDependency"
        + " WHERE RefMetadataComponentId = '" + cp.Id + "'", true);
      if (!alive()) return;
      const rows = recs.map(r => ({
        id: r.MetadataComponentId,
        name: r.MetadataComponentName || r.MetadataComponentId,
        type: r.MetadataComponentType || "",
        namespace: r.MetadataComponentNamespace || "",
        link: this.sfLink + "/" + r.MetadataComponentId,
      })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
      const patch = {status: "done", rows, error: ""};
      if (recs.length >= USAGE_LIMIT) {
        patch.limitReached = true;
      }
      this.setSection("usage", patch);
    } catch (err) {
      console.error(err);
      if (!alive()) return;
      this.setSection("usage", {status: "error", error: "Error loading usage (Tooling API): " + err.message});
    }
  }

  // ----- Validation rules -----

  /** All validation rules with their formula. Loaded once per session (5 composite calls per 115 rules). */
  scanValidationRules() {
    if (!this.vrCache) {
      this.vrCache = (async () => {
        const list = await this.queryAll("SELECT Id, ValidationName, Active, ErrorMessage, NamespacePrefix,"
          + " EntityDefinition.QualifiedApiName FROM ValidationRule", true);
        const formulas = {};
        let failed = 0;
        const base = "/services/data/v" + apiVersion + "/tooling";
        // Composite allows 25 subrequests but only 5 queries: retrieve each rule as a record instead
        this.logSoql("GET /tooling/sobjects/ValidationRule/<each rule> (Metadata.errorConditionFormula)", true);
        for (const part of chunk(list, COMPOSITE_SIZE)) {
          const res = await sfConn.rest(base + "/composite", {method: "POST", body: {
            allOrNone: false,
            compositeRequest: part.map((r, i) => ({
              method: "GET",
              referenceId: "vr" + i,
              url: base + "/sobjects/ValidationRule/" + r.Id,
            })),
          }});
          const subs = (res && res.compositeResponse) || [];
          part.forEach((r, i) => {
            const sub = subs.find(x => x.referenceId === "vr" + i);
            const rec = sub && sub.httpStatusCode === 200 && sub.body;
            if (rec && rec.Metadata) formulas[r.Id] = rec.Metadata.errorConditionFormula || "";
            else failed++;
          });
        }
        const rules = list.map(r => {
          const object = (r.EntityDefinition && r.EntityDefinition.QualifiedApiName) || "";
          return {
            id: r.Id,
            name: r.ValidationName,
            namespace: r.NamespacePrefix || "",
            object,
            active: !!r.Active,
            errorMessage: r.ErrorMessage || "",
            formula: formulas[r.Id],
            link: this.sfLink + "/lightning/setup/ObjectManager/" + encodeURIComponent(object)
              + "/ValidationRules/" + r.Id + "/view",
          };
        });
        return {rules, failed};
      })();
      this.vrCache.catch(() => { this.vrCache = null; }); // allow a retry on the next selection
    }
    return this.vrCache;
  }

  async loadValidation(cp, alive) {
    try {
      const {rules, failed} = await this.scanValidationRules();
      if (!alive()) return;
      const apiName = apiNameOf(cp.NamespacePrefix, cp.DeveloperName);
      const regex = cpRegex(PERMISSION_PREFIX, apiName);
      // Inside its own package a namespaced CP can be referenced without prefix
      const bareRegex = cp.NamespacePrefix ? cpRegex(PERMISSION_PREFIX, cp.DeveloperName) : null;
      const rows = rules.filter(r => r.formula
        && (regex.test(r.formula) || (bareRegex && r.namespace === cp.NamespacePrefix && bareRegex.test(r.formula))))
        .sort((a, b) => a.object.localeCompare(b.object) || a.name.localeCompare(b.name));
      this.setSection("validation", {status: "done", rows, error: "", failed, total: rules.length});
    } catch (err) {
      console.error(err);
      if (!alive()) return;
      this.setSection("validation", {status: "error", error: "Error loading validation rules (Tooling API): " + err.message});
    }
  }

  // ----- Code (LWC, Aura, Visualforce) -----

  /** Own source files of LWC, Aura and Visualforce. Loaded once per session. */
  scanCode() {
    if (!this.codeCache) {
      this.codeCache = (async () => {
        const setup = this.sfLink + "/lightning/setup/";
        const sources = [
          {type: "LWC", tooling: true,
            soql: "SELECT Id, FilePath, Source, LightningComponentBundleId, LightningComponentBundle.NamespacePrefix"
              + " FROM LightningComponentResource WHERE FilePath LIKE 'lwc/%.js'",
            map: r => ({ns: r.LightningComponentBundle && r.LightningComponentBundle.NamespacePrefix,
              name: (r.FilePath || "").replace(/^lwc\//, ""), source: r.Source,
              link: setup + "LightningComponentBundles/page?address=%2F" + r.LightningComponentBundleId})},
          {type: "Aura", tooling: true,
            soql: "SELECT Id, DefType, Source, AuraDefinitionBundleId, AuraDefinitionBundle.DeveloperName,"
              + " AuraDefinitionBundle.NamespacePrefix FROM AuraDefinition WHERE DefType IN ('COMPONENT', 'APPLICATION')",
            map: r => ({ns: r.AuraDefinitionBundle && r.AuraDefinitionBundle.NamespacePrefix,
              name: ((r.AuraDefinitionBundle && r.AuraDefinitionBundle.DeveloperName) || r.AuraDefinitionBundleId)
                + (r.DefType === "APPLICATION" ? ".app" : ".cmp"), source: r.Source,
              link: setup + "LightningComponentBundles/page?address=%2F" + r.AuraDefinitionBundleId})},
          {type: "VF Page", tooling: false,
            soql: "SELECT Id, Name, Markup FROM ApexPage WHERE NamespacePrefix = null",
            map: r => ({name: r.Name, source: r.Markup, link: setup + "ApexPages/page?address=%2F" + r.Id})},
          {type: "VF Component", tooling: false,
            soql: "SELECT Id, Name, Markup FROM ApexComponent WHERE NamespacePrefix = null",
            map: r => ({name: r.Name, source: r.Markup, link: setup + "ApexComponents/page?address=%2F" + r.Id})},
        ];
        const failedTypes = [];
        const results = await Promise.all(sources.map(src => this.queryAll(src.soql, src.tooling)
          .then(recs => recs.map(src.map).filter(f => !f.ns).map(f => Object.assign(f, {type: src.type})))
          .catch(err => { console.warn(src.type + " scan failed", err); failedTypes.push(src.type + " (" + err.message + ")"); return []; })));
        if (failedTypes.length === sources.length) throw new Error(failedTypes.join("; "));
        return {files: [].concat(...results), failedTypes};
      })();
      this.codeCache.catch(() => { this.codeCache = null; });
    }
    return this.codeCache;
  }

  async loadCode(cp, alive) {
    try {
      const {files, failedTypes} = await this.scanCode();
      if (!alive()) return;
      const apiName = apiNameOf(cp.NamespacePrefix, cp.DeveloperName);
      const lwc = cpRegex(LWC_PREFIX, apiName);
      const perm = cpRegex(PERMISSION_PREFIX, apiName);
      const rows = [];
      for (const f of files) {
        matchLines(f.source, f.type === "LWC" ? lwc : perm).forEach(m => {
          rows.push({id: f.link + "#" + f.name + ":" + m.line, type: f.type, name: f.name, line: m.line, text: m.text, link: f.link});
        });
      }
      rows.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.line - b.line);
      this.setSection("code", {status: "done", rows, error: "", failedTypes, total: files.length});
    } catch (err) {
      console.error(err);
      if (!alive()) return;
      this.setSection("code", {status: "error", error: "Error loading code: " + err.message});
    }
  }

  // ----- Filtering -----

  usageTypes() {
    const set = {};
    this.sections.usage.rows.forEach(r => { set[r.type] = true; });
    return Object.keys(set).sort();
  }

  baseRows(tab) {
    let rows = this.sections[tab].rows;
    if (tab === "users" && this.activeOnly) rows = rows.filter(r => r.active);
    if (tab === "usage" && this.usageType) rows = rows.filter(r => r.type === this.usageType);
    if (tab === "validation" && this.activeRulesOnly) rows = rows.filter(r => r.active);
    return rows;
  }

  searchText(tab, r) {
    switch (tab) {
      case "profiles": return r.name;
      case "permSets": return r.label + " " + r.apiName + " " + r.license;
      case "groups": return r.label + " " + r.apiName + " " + r.status + " " + r.viaPS.join(" ");
      case "users": return r.name + " " + r.username;
      case "validation": return r.object + " " + r.name + " " + r.errorMessage;
      case "code": return r.type + " " + r.name + " " + r.text;
      case "usage": return r.name + " " + r.type + " " + r.namespace;
      default: return "";
    }
  }

  filteredRows(tab) {
    const f = this.filters[tab].trim().toLowerCase();
    const rows = this.baseRows(tab);
    if (!f) return rows;
    return rows.filter(r => this.searchText(tab, r).toLowerCase().includes(f));
  }

  // ----- Export -----

  csvTable(tab) {
    const rows = this.filteredRows(tab);
    switch (tab) {
      case "profiles":
        return {header: ["Profile"], rows: rows.map(r => [r.name])};
      case "permSets":
        return {header: ["Label", "API Name", "License", "Session activation"],
          rows: rows.map(r => [r.label, r.apiName, r.license, r.session ? "Yes" : "No"])};
      case "groups":
        return {header: ["Label", "API Name", "Status", "Grants CP", "Session activation", "Via Permission Set"],
          rows: rows.map(r => [r.label, r.apiName, r.status, r.granted ? "Yes" : "No", r.session ? "Yes" : "No", r.viaPS.join(" | ")])};
      case "users":
        return {header: ["Name", "Username", "Profile", "Access via", "Active", "Expiration date"],
          rows: rows.map(r => [r.name, r.username, r.profile,
            r.vias.map(v => v.kind + ": " + v.name).join(" | "), r.active ? "Yes" : "No", formatDate(r.expiration)])};
      case "validation":
        return {header: ["Object", "Rule", "Active", "Error message", "Formula"],
          rows: rows.map(r => [r.object, r.name, r.active ? "Yes" : "No", r.errorMessage, r.formula])};
      case "code":
        return {header: ["Type", "Name", "Line", "Match"], rows: rows.map(r => [r.type, r.name, r.line, r.text])};
      case "usage":
        return {header: ["Name", "Type", "Namespace"], rows: rows.map(r => [r.name, r.type, r.namespace])};
      default:
        return {header: [], rows: []};
    }
  }

  toCsv(table) {
    return [table.header].concat(table.rows).map(line => line.map(csvCell).join(",")).join("\r\n");
  }

  exportCsv(all) {
    const cp = this.selectedCP;
    if (!cp) return;
    let text;
    if (all) {
      text = TABS.map(t => t.label + "\r\n" + this.toCsv(this.csvTable(t.id))).join("\r\n\r\n");
    } else {
      text = this.toCsv(this.csvTable(this.activeTab));
    }
    const blob = new Blob(["\uFEFF" + text], {type: "text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "where-is-cp_" + cp.DeveloperName + "_" + (all ? "all" : this.activeTab) + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  copySoql() {
    if (!this.soqlLog.length) return;
    copyToClipboard(this.soqlLog.join(";\n\n") + ";");
  }

  tabCount(tab) {
    const s = this.sections[tab];
    if (s.status === "loading") return "\u2026";
    if (s.status === "error") return "!";
    if (s.status === "idle") return "";
    return String(this.baseRows(tab).length);
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

/** Highlights every match of the regex (global) in the text. */
function MarkAll({text, regex}) {
  text = text || "";
  const parts = [];
  let last = 0;
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(h("mark", {key: "m" + m.index}, m[0]));
    last = m.index + m[0].length;
    if (m[0].length === 0) regex.lastIndex++;
  }
  if (last < text.length) parts.push(text.slice(last));
  return h("span", {}, ...parts);
}

class CPSearch extends React.Component {
  constructor(props) {
    super(props);
    this.state = {query: "", activeIndex: -1};
    this.onChange = this.onChange.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onSearch = this.onSearch.bind(this);
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

  pick(cp) {
    this.setState({activeIndex: -1});
    this.props.model.selectCP(cp);
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
    return h("div", {className: "wc-search-wrapper"},
      h("div", {className: "slds-form-element"},
        h("label", {className: "slds-form-element__label"}, "Search custom permission"),
        h("div", {className: "wc-search-row"},
          h("div", {className: "slds-form-element__control slds-input-has-icon slds-input-has-icon_left wc-search-input"},
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
        )
      ),
      model.resultsVisible && model.searchDone && h("div", {className: "wc-results"},
        results.length === 0
          ? h("div", {className: "wc-result-item wc-sub"}, "No custom permissions match \u00ab" + model.searchedQuery + "\u00bb")
          : h("div", {ref: this.setListEl},
            results.map((cp, idx) =>
              h("div", {
                key: cp.Id,
                className: "wc-result-item" + (idx === activeIndex ? " wc-active" : "")
                  + (model.selectedCP && model.selectedCP.Id === cp.Id ? " wc-selected" : ""),
                onClick: () => this.pick(cp),
              },
              h("div", {}, h(Mark, {text: cp.MasterLabel, query: model.searchedQuery})),
              h("div", {className: "wc-sub"},
                h(Mark, {text: apiNameOf(cp.NamespacePrefix, cp.DeveloperName), query: model.searchedQuery}),
                " \u00b7 Custom Permission")
              )
            )
          ),
        model.searchHasMore && h("div", {className: "wc-result-item wc-sub wc-more"},
          "Showing the first " + SEARCH_LIMIT + " results, refine the search.")
      )
    );
  }
}

function Badge({className, text}) {
  return h("span", {className: "slds-badge " + className}, text);
}

function LinkCell({row, text}) {
  return row.link
    ? h("a", {href: row.link, target: "_blank", rel: "noopener noreferrer"}, text)
    : h("span", {}, text);
}

function Table({headers, children}) {
  return h("table", {className: "slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped wc-table"},
    h("thead", {}, h("tr", {className: "slds-line-height_reset"}, headers.map(t => h("th", {key: t}, t)))),
    h("tbody", {}, children));
}

const VIA_BADGE = {Profile: "wc-badge-profile", PS: "wc-badge-ps", PSG: "wc-badge-psg"};

function TabTable({tab, rows, model}) {
  switch (tab) {
    case "profiles":
      return h(Table, {headers: ["Profile"]},
        rows.map(r => h("tr", {key: r.psId}, h("td", {}, h(LinkCell, {row: r, text: r.name})))));
    case "permSets":
      return h(Table, {headers: ["Label", "API Name", "License"]},
        rows.map(r => h("tr", {key: r.id},
          h("td", {}, h(LinkCell, {row: r, text: r.label}),
            r.session && h("span", {className: "slds-m-left_x-small"}, h(Badge, {className: "wc-badge-session", text: "Session"}))),
          h("td", {}, h("code", {}, r.apiName)),
          h("td", {}, r.license))));
    case "groups":
      return h(Table, {headers: ["Label", "API Name", "Status", "Via Permission Set"]},
        rows.map(r => h("tr", {key: r.id},
          h("td", {}, h(LinkCell, {row: r, text: r.label}),
            r.session && h("span", {className: "slds-m-left_x-small"}, h(Badge, {className: "wc-badge-session", text: "Session"})),
            !r.granted && h("span", {className: "slds-m-left_x-small", title: "Contains a permission set with this custom permission,"
              + " but the group does not grant it (muted, or the group is not recalculated). Its users are not counted."},
            h(Badge, {className: "wc-badge-warn", text: "Not granted"}))),
          h("td", {}, h("code", {}, r.apiName)),
          h("td", {}, h(Badge, {className: statusBadgeClass(r.status), text: r.status || "\u2013"})),
          h("td", {}, r.viaPS.map(p => h("span", {key: p, className: "wc-via"}, h(Badge, {className: "wc-badge-ps", text: p})))))));
    case "users":
      return h(Table, {headers: ["Name", "Username", "Profile", "Access via", "Active", "Expiration date"]},
        rows.map(r => h("tr", {key: r.id},
          h("td", {}, h(LinkCell, {row: r, text: r.name})),
          h("td", {}, r.username),
          h("td", {}, r.profile),
          h("td", {}, r.vias.map(v => h("span", {key: v.kind + v.name, className: "wc-via"},
            h(Badge, {className: VIA_BADGE[v.kind], text: v.kind + ": " + v.name + (v.expiration ? " (until " + formatDate(v.expiration) + ")" : "")})))),
          h("td", {}, h(Badge, {className: r.active ? "wc-badge-on" : "wc-badge-off", text: r.active ? "Active" : "Inactive"})),
          h("td", {}, r.expiration ? formatDate(r.expiration) : "Never"))));
    case "validation": {
      const cp = model.selectedCP;
      const regex = cpRegex(PERMISSION_PREFIX, apiNameOf(cp.NamespacePrefix, cp.DeveloperName), true);
      const trs = [];
      rows.forEach(r => {
        const open = !!model.expanded[r.id];
        trs.push(h("tr", {key: r.id},
          h("td", {}, h("button", {
            className: "slds-button wc-expand",
            title: open ? "Hide formula" : "Show formula",
            onClick: () => model.toggleExpanded(r.id),
          }, open ? "\u25BE" : "\u25B8")),
          h("td", {}, r.object),
          h("td", {}, h(LinkCell, {row: r, text: r.name})),
          h("td", {}, h(Badge, {className: r.active ? "wc-badge-on" : "wc-badge-off", text: r.active ? "Active" : "Inactive"})),
          h("td", {className: "wc-wrap"}, r.errorMessage)));
        if (open) {
          trs.push(h("tr", {key: r.id + "-f", className: "wc-formula-row"},
            h("td", {colSpan: 5}, h("pre", {className: "wc-formula"}, h(MarkAll, {text: r.formula, regex})))));
        }
      });
      return h(Table, {headers: ["", "Object", "Rule", "Active", "Error message"]}, trs);
    }
    case "code": {
      const cp = model.selectedCP;
      const apiName = apiNameOf(cp.NamespacePrefix, cp.DeveloperName);
      const lwc = cpRegex(LWC_PREFIX, apiName, true);
      const perm = cpRegex(PERMISSION_PREFIX, apiName, true);
      return h(Table, {headers: ["Type", "Name", "Line", "Match"]},
        rows.map(r => h("tr", {key: r.id},
          h("td", {}, r.type),
          h("td", {}, h(LinkCell, {row: r, text: r.name})),
          h("td", {}, r.line),
          h("td", {className: "wc-wrap"}, h("code", {}, h(MarkAll, {text: r.text, regex: r.type === "LWC" ? lwc : perm}))))));
    }
    case "usage":
      return h(Table, {headers: ["Name", "Type", "Namespace"]},
        rows.map(r => h("tr", {key: r.id},
          h("td", {}, h(LinkCell, {row: r, text: r.name})),
          h("td", {}, r.type),
          h("td", {}, r.namespace))));
    default:
      return h("div", {});
  }
}

const FILTER_PLACEHOLDER = {
  profiles: "Filter by profile",
  permSets: "Filter by label, API name or license",
  groups: "Filter by group or permission set",
  users: "Filter by name or username",
  validation: "Filter by object, rule or message",
  code: "Filter by type, name or code",
  usage: "Filter by name or type",
};

const EMPTY_TEXT = {
  profiles: "No assignments.",
  permSets: "No assignments.",
  groups: "No assignments.",
  users: "No users have this custom permission.",
  validation: "No validation rules reference this custom permission.",
  code: "No LWC, Aura or Visualforce code references this custom permission.",
  usage: "No references found.",
};

class App extends React.Component {
  constructor(props) {
    super(props);
    this.model = this.props.vm;
    this.onFilter = this.onFilter.bind(this);
    this.onActiveOnly = this.onActiveOnly.bind(this);
    this.onUsageType = this.onUsageType.bind(this);
    this.onActiveRulesOnly = this.onActiveRulesOnly.bind(this);
  }

  onActiveRulesOnly(e) { this.model.activeRulesOnly = e.target.checked; this.model.didUpdate(); }

  onFilter(e) { this.model.filters[this.model.activeTab] = e.target.value; this.model.didUpdate(); }
  onActiveOnly(e) { this.model.activeOnly = e.target.checked; this.model.didUpdate(); }
  onUsageType(e) { this.model.usageType = e.target.value; this.model.didUpdate(); }

  renderTabs() {
    const model = this.model;
    return h("div", {className: "slds-tabs_default"},
      h("ul", {className: "slds-tabs_default__nav wc-tabs-nav", role: "tablist"},
        TABS.map(t => {
          const count = model.tabCount(t.id);
          return h("li", {
            key: t.id,
            className: "slds-tabs_default__item" + (model.activeTab === t.id ? " slds-is-active" : ""),
            role: "presentation",
          },
          h("a", {
            className: "slds-tabs_default__link",
            href: "#",
            role: "tab",
            onClick: (e) => { e.preventDefault(); model.setTab(t.id); },
          }, t.label + (count ? " (" + count + ")" : "")));
        })
      )
    );
  }

  renderToolbar(tab, rows) {
    const model = this.model;
    return h("div", {className: "wc-toolbar"},
      h("input", {
        type: "search",
        className: "slds-input wc-filter-input",
        placeholder: FILTER_PLACEHOLDER[tab],
        value: model.filters[tab],
        onChange: this.onFilter,
      }),
      tab === "users" && h("div", {className: "slds-checkbox"},
        h("input", {type: "checkbox", id: "wc-active-only", checked: model.activeOnly, onChange: this.onActiveOnly}),
        h("label", {className: "slds-checkbox__label", htmlFor: "wc-active-only"},
          h("span", {className: "slds-checkbox_faux"}),
          h("span", {className: "slds-form-element__label"}, "Active users only"))),
      tab === "validation" && h("div", {className: "slds-checkbox"},
        h("input", {type: "checkbox", id: "wc-active-rules", checked: model.activeRulesOnly, onChange: this.onActiveRulesOnly}),
        h("label", {className: "slds-checkbox__label", htmlFor: "wc-active-rules"},
          h("span", {className: "slds-checkbox_faux"}),
          h("span", {className: "slds-form-element__label"}, "Active rules only"))),
      tab === "usage" && h("select", {className: "slds-select wc-select", value: model.usageType, onChange: this.onUsageType},
        h("option", {value: ""}, "All types"),
        model.usageTypes().map(t => h("option", {key: t, value: t}, t))),
      h("div", {className: "wc-toolbar-spacer"}),
      h("button", {
        className: "slds-button slds-button_neutral",
        disabled: rows.length === 0,
        onClick: () => model.exportCsv(false),
        title: "Download the visible rows of this tab as CSV",
      }, "Export tab CSV"),
      h("button", {
        className: "slds-button slds-button_neutral",
        disabled: model.spinnerCount > 0,
        onClick: () => model.exportCsv(true),
        title: "Download all tabs in one CSV file",
      }, "Export all CSV"),
      h("button", {
        className: "slds-button slds-button_neutral",
        disabled: model.soqlLog.length === 0,
        onClick: () => model.copySoql(),
        title: "Copy the SOQL queries used to the clipboard",
      }, "Copy SOQL")
    );
  }

  renderTabBody(tab, rows) {
    const model = this.model;
    const section = model.sections[tab];
    if (section.status === "loading") {
      const text = tab === "validation" ? "Scanning validation rules\u2026"
        : tab === "code" ? "Scanning LWC, Aura and Visualforce code\u2026" : "Loading\u2026";
      return h("div", {className: "wc-empty"}, text);
    }
    if (section.status === "error") {
      return h("div", {className: "slds-notify slds-notify_alert slds-theme_error", role: "alert"}, section.error);
    }
    const base = model.baseRows(tab);
    return h("div", {},
      tab === "usage" && h("div", {className: "wc-note"},
        "Only references that Salesforce tracks as dependencies are shown. $Permission in validation rules and references in code "
        + "are usually not tracked: see the Validation Rules and Code tabs. Apex (FeatureManagement.checkPermission) is not scanned."),
      tab === "validation" && h("div", {className: "wc-note"},
        "Formulas of " + (section.total || 0) + " validation rules scanned for $Permission." + apiNameOf(model.selectedCP.NamespacePrefix, model.selectedCP.DeveloperName)
        + ". References inside formula comments are also listed."
        + (section.failed ? " " + section.failed + " rules could not be read and were skipped." : "")),
      tab === "code" && h("div", {className: "wc-note"},
        (section.total || 0) + " own files scanned (LWC JavaScript, Aura markup, Visualforce pages and components). "
        + "Apex is not scanned. References inside comments are also listed."
        + (section.failedTypes && section.failedTypes.length ? " Not scanned: " + section.failedTypes.join(", ") + "." : "")),
      tab === "usage" && section.limitReached && h("div", {className: "wc-note"},
        "The API returned its limit of " + USAGE_LIMIT + " rows: the list may be incomplete."),
      section.rows.length === 0 && h("div", {className: "wc-empty"}, EMPTY_TEXT[tab]),
      section.rows.length > 0 && base.length === 0 && tab === "users" && h("div", {className: "wc-empty"}, "No active users. Uncheck \u201cActive users only\u201d to see inactive ones."),
      base.length > 0 && rows.length === 0 && h("div", {className: "wc-empty"}, "No rows match the filter."),
      rows.length > 0 && h(TabTable, {tab, rows, model})
    );
  }

  render() {
    const model = this.model;
    document.title = model.title;
    const cp = model.selectedCP;
    const tab = model.activeTab;
    const rows = cp ? model.filteredRows(tab) : [];
    return h("div", {},
      h(PageHeader, {
        pageTitle: "Where is CP",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        ...model.userInfoModel.getProps()
      }),
      h("div", {className: "slds-m-top_xx-large sfir-page-container"},
        h("div", {className: "slds-card slds-m-around_medium", style: {flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0}},
          h("div", {className: "slds-card__header slds-p-horizontal_small slds-p-top_small"},
            h(CPSearch, {model})
          ),
          h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1", overflowY: "auto", minHeight: 0}},
            model.errorMessages.length > 0 &&
              h("div", {className: "slds-notify slds-notify_alert slds-theme_error slds-m-bottom_small", role: "alert"},
                model.errorMessages[model.errorMessages.length - 1]),
            !cp && h("div", {className: "wc-empty"}, "Search and select a custom permission to see where it is assigned and used."),
            cp && h("div", {className: "wc-header"},
              h("h2", {className: "slds-text-heading_small"},
                h("a", {
                  href: model.sfLink + "/lightning/setup/CustomPermissions/page?address=%2F" + cp.Id,
                  target: "_blank",
                  rel: "noopener noreferrer",
                }, cp.MasterLabel),
                !model.resultsVisible && model.searchResults.length > 0 && h("a", {
                  className: "slds-m-left_small slds-text-body_small",
                  href: "#",
                  onClick: (e) => { e.preventDefault(); model.showResults(); },
                }, "Change")),
              h("p", {className: "slds-text-body_small slds-text-color_weak"},
                h("code", {}, apiNameOf(cp.NamespacePrefix, cp.DeveloperName)), " \u00b7 Custom Permission"),
              cp.Description && h("p", {className: "slds-text-body_small slds-m-top_xx-small"}, cp.Description)
            ),
            cp && model.warnings.length > 0 && h("div", {className: "wc-note"}, model.warnings.join(" ")),
            cp && this.renderTabs(),
            cp && this.renderToolbar(tab, rows),
            cp && this.renderTabBody(tab, rows)
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
