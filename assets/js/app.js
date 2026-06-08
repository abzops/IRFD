import {
  FOLLOWUP_MODES,
  LOST_REASONS,
  PAYMENT_STATUS_OPTIONS,
  STATUS_OPTIONS,
  addDays,
  applyTableFilters,
  calculateDashboardCounts,
  calculateFunnel,
  calculateInsurerPerformance,
  calculateLostReasonSummary,
  calculateMonthlyReport,
  calculateStaffPerformance,
  decorateLead,
  filterLeadsByView,
  isClosedStatus,
  todayIso
} from "./logic.js";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const CONFIG_KEY = "irfd.supabase.config";
const DEMO_KEY = "irfd.demo.snapshot";
const DEMO_ENABLED_KEY = "irfd.demo.enabled";
const THEME_KEY = "irfd.theme";
const INSIGHTS_KEY = "irfd.insights.expanded";
const ACTIVITIES_KEY = "irfd.activities";

const app = document.querySelector("#app");

const navItems = [
  { id: "overview", label: "Overview", icon: "layout-dashboard" },
  { id: "today", label: "Today's Follow-ups", icon: "phone-call" },
  { id: "expiring", label: "Expiring Soon", icon: "alarm-clock" },
  { id: "quote", label: "Quote Sent", icon: "send" },
  { id: "payment", label: "Payment Pending", icon: "indian-rupee" },
  { id: "renewed", label: "Renewed Policies", icon: "badge-check" },
  { id: "lost", label: "Lost Leads", icon: "circle-off" },
  { id: "reports", label: "Reports", icon: "bar-chart-3" },
  { id: "activity", label: "Activity Log", icon: "activity" }
];

const state = {
  mode: "loading",
  route: "overview",
  client: null,
  session: null,
  leads: [],
  followups: [],
  reportViews: null,
  selectedLeadId: null,
  editingLeadId: null,
  filters: {
    query: "",
    status: "",
    executive: "",
    sortBy: ""
  },
  busy: false,
  toast: null,
  theme: localStorage.getItem(THEME_KEY) || "dark",
  insightsExpanded: localStorage.getItem(INSIGHTS_KEY) === "true",
  detailTab: "overview",
  activities: [],
  authMode: "login",
  showDevConfig: false
};

// Initial theme application to prevent flash of wrong colors
applyTheme();
init();

function applyTheme() {
  if (state.theme === "light") {
    document.body.classList.add("light-theme");
  } else {
    document.body.classList.remove("light-theme");
  }
}

async function init() {
  state.route = getRouteFromHash();
  window.addEventListener("hashchange", () => {
    state.route = getRouteFromHash();
    state.selectedLeadId = null;
    state.detailTab = "overview";
    render();
  });

  // Load local activities
  try {
    state.activities = JSON.parse(localStorage.getItem(ACTIVITIES_KEY) || "[]");
  } catch (_) {
    state.activities = [];
  }

  const config = getStoredConfig();
  const demoRequested = new URLSearchParams(window.location.search).has("demo") || localStorage.getItem(DEMO_ENABLED_KEY) === "true";

  if (hasSupabaseConfig(config)) {
    state.client = createClient(config.url, config.anonKey);
    const { data } = await state.client.auth.getSession();
    state.session = data.session;
    state.mode = state.session ? "app" : "auth";

    state.client.auth.onAuthStateChange(async (_event, session) => {
      const isLoggingIn = !state.session && session;
      state.session = session;
      state.mode = session ? "app" : "auth";
      if (session) {
        await loadData();
        if (isLoggingIn) {
          logActivity("Staff Login", `Session started for ${session.user.email}`);
        }
      }
      render();
    });

    if (state.session) await loadData();
    render();
    return;
  }

  if (demoRequested) {
    enableDemoMode();
    return;
  }

  state.mode = "setup";
  render();
}

function getRouteFromHash() {
  const value = window.location.hash.replace("#", "");
  return navItems.some((item) => item.id === value) ? value : "overview";
}

function getStoredConfig() {
  const inline = window.IRFD_SUPABASE || {};
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
  } catch (_error) {
    saved = {};
  }
  return {
    url: inline.url || saved.url || "",
    anonKey: inline.anonKey || saved.anonKey || ""
  };
}

function hasSupabaseConfig(config) {
  return Boolean(config.url && config.anonKey && !config.url.includes("YOUR_") && !config.anonKey.includes("YOUR_"));
}

function isProductionConfigured() {
  const inline = window.IRFD_SUPABASE || {};
  return Boolean(inline.url && inline.anonKey && !inline.url.includes("YOUR_") && !inline.anonKey.includes("YOUR_"));
}

async function loadData() {
  if (!state.client || !state.session) return;
  state.busy = true;
  render();

  try {
    const [renewalsResult, followupsResult] = await Promise.all([
      state.client.from("insurance_renewals_enriched").select("*").order("policy_expiry_date", { ascending: true }),
      state.client.from("renewal_followups").select("*").order("followup_date", { ascending: false })
    ]);

    if (renewalsResult.error) throw renewalsResult.error;
    if (followupsResult.error) throw followupsResult.error;

    state.leads = renewalsResult.data || [];
    state.followups = followupsResult.data || [];
    
    // Sync activities list with the newly loaded followups database rows
    syncActivitiesWithFollowups();
    
    await loadReportViews();
    state.toast = null;
  } catch (error) {
    state.toast = { type: "error", message: `Supabase load failed: ${error.message}` };
  } finally {
    state.busy = false;
    render();
  }
}

async function loadReportViews() {
  const viewQueries = [
    ["funnel", "renewal_conversion_funnel"],
    ["staff", "renewal_staff_performance"],
    ["insurers", "renewal_insurer_performance"],
    ["lostReasons", "renewal_lost_reason_summary"],
    ["monthly", "renewal_monthly_report"]
  ];

  const results = await Promise.all(
    viewQueries.map(async ([key, view]) => {
      const { data, error } = await state.client.from(view).select("*");
      return [key, error ? null : data];
    })
  );

  state.reportViews = Object.fromEntries(results);
}

function enableDemoMode() {
  localStorage.setItem(DEMO_ENABLED_KEY, "true");
  state.mode = "demo";
  const snapshot = getDemoSnapshot();
  state.leads = snapshot.leads;
  state.followups = snapshot.followups;
  syncActivitiesWithFollowups();
  state.reportViews = null;
  render();
}

function getDemoSnapshot() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEMO_KEY) || "null");
    if (saved?.leads?.length) return saved;
  } catch (_error) {
    // Fall through to fresh sample data.
  }

  const leads = buildDemoLeads();
  const followups = buildDemoFollowups(leads);
  const snapshot = { leads, followups };
  localStorage.setItem(DEMO_KEY, JSON.stringify(snapshot));
  return snapshot;
}

function persistDemo() {
  if (state.mode === "demo") {
    localStorage.setItem(DEMO_KEY, JSON.stringify({ leads: state.leads, followups: state.followups }));
  }
}

function buildDemoLeads() {
  const today = todayIso();
  return [
    demoLead("Rajesh Kumar", "KL 07 AB 1234", "Swift", "Quote Sent", 6, "Asha Nair", "Maruti Insurance", 17800, {
      mobile_number: "9876500011",
      next_followup_date: today,
      customer_response: "Wants revised premium",
      quote_sent_date: addDays(today, -1)
    }),
    demoLead("Anil Menon", "KL 08 CD 7788", "Baleno", "Not Reachable", 1, "Asha Nair", "ICICI Lombard", 16500, {
      mobile_number: "9876500022",
      next_followup_date: today,
      customer_response: "Call not connected"
    }),
    demoLead("Meera Joseph", "KL 11 XY 2233", "Brezza", "New Lead", 18, "Ravi Kumar", "HDFC Ergo", 17200, {
      mobile_number: "9876500033",
      next_followup_date: today
    }),
    demoLead("Nisha Varghese", "KL 05 MN 9090", "Fronx", "Payment Pending", 3, "Ravi Kumar", "Maruti Insurance", 21400, {
      mobile_number: "9876500044",
      payment_status: "Pending",
      quote_sent_date: addDays(today, -2),
      next_followup_date: today,
      customer_response: "Payment link requested"
    }),
    demoLead("Vivek Thomas", "KL 09 PP 3344", "Ertiga", "Renewed", 20, "Asha Nair", "Maruti Insurance", 24500, {
      mobile_number: "9876500055",
      payment_status: "Collected",
      renewal_date: today,
      closed_at: `${today}T10:00:00+05:30`
    }),
    demoLead("Suresh Babu", "KL 10 AA 1230", "WagonR", "Lost", -2, "Neha Shah", "ICICI Lombard", 12800, {
      mobile_number: "9876500066",
      lost_reason: "Renewed Elsewhere",
      customer_response: "Already renewed outside",
      closed_at: `${today}T11:00:00+05:30`
    }),
    demoLead("Farah Ali", "KL 13 GH 4545", "Grand Vitara", "Contacted", 31, "Neha Shah", "HDFC Ergo", 31500, {
      mobile_number: "9876500077",
      next_followup_date: addDays(today, 5),
      customer_response: "Call later"
    }),
    demoLead("Hari Krishnan", "KL 06 JK 8721", "Celerio", "Follow-up Pending", 12, "Asha Nair", "Maruti Insurance", 14250, {
      mobile_number: "9876500088",
      next_followup_date: addDays(today, 1),
      quote_sent_date: addDays(today, -1)
    }),
    demoLead("Deepa S", "KL 01 LM 2301", "Jimny", "Interested", 8, "Ravi Kumar", "Tata AIG", 28900, {
      mobile_number: "9876500099",
      next_followup_date: today,
      customer_response: "Interested"
    }),
    demoLead("Kavya Prasad", "KL 02 NP 7741", "Ignis", "Quote Requested", 29, "Neha Shah", "HDFC Ergo", 15400, {
      mobile_number: "9876500101",
      next_followup_date: today,
      customer_response: "Wants quote"
    }),
    demoLead("Omar Latheef", "KL 14 RS 5588", "Brezza", "Lost", 5, "Asha Nair", "Maruti Insurance", 18100, {
      mobile_number: "9876500111",
      lost_reason: "Not Interested",
      customer_response: "Not Interested",
      closed_at: `${today}T13:00:00+05:30`
    }),
    demoLead("Latha Devi", "KL 03 TU 8822", "Alto K10", "Call Pending", -1, "Ravi Kumar", "ICICI Lombard", 9800, {
      mobile_number: "9876500121",
      next_followup_date: today
    })
  ];
}

function demoLead(customerName, vehicleNumber, model, status, daysUntilExpiry, executive, insurer, premium, overrides = {}) {
  const today = todayIso();
  const id = crypto.randomUUID();
  return {
    id,
    customer_name: customerName,
    mobile_number: overrides.mobile_number || "9876500000",
    vehicle_number: vehicleNumber,
    model,
    variant: overrides.variant || "VXI",
    registration_date: overrides.registration_date || addDays(today, -730),
    service_advisor: overrides.service_advisor || "Service Team",
    relationship_manager: overrides.relationship_manager || executive,
    current_insurer: insurer,
    policy_number: overrides.policy_number || `POL-${vehicleNumber.replace(/\s+/g, "")}`,
    policy_expiry_date: addDays(today, daysUntilExpiry),
    previous_premium: overrides.previous_premium || premium + 700,
    renewal_quote_amount: premium,
    idv: overrides.idv || 550000,
    ncb_percentage: overrides.ncb_percentage || 20,
    policy_type: overrides.policy_type || "Comprehensive",
    addons: overrides.addons || ["Zero Dep", "RSA"],
    current_status: status,
    customer_response: overrides.customer_response || "",
    lost_reason: overrides.lost_reason || null,
    last_followup_date: overrides.last_followup_date || addDays(today, -1),
    next_followup_date: overrides.next_followup_date || null,
    assigned_executive: executive,
    payment_status: overrides.payment_status || "Not Started",
    quote_sent_date: overrides.quote_sent_date || null,
    renewal_date: overrides.renewal_date || null,
    remarks: overrides.remarks || "",
    closed_at: overrides.closed_at || null,
    created_at: `${today}T09:00:00+05:30`,
    updated_at: `${today}T09:00:00+05:30`
  };
}

function buildDemoFollowups(leads) {
  return leads
    .filter((lead) => lead.last_followup_date)
    .map((lead) => ({
      id: crypto.randomUUID(),
      renewal_id: lead.id,
      followup_date: lead.last_followup_date,
      followup_by: lead.assigned_executive,
      followup_mode: lead.current_status === "Quote Sent" ? "WhatsApp" : "Call",
      customer_response: lead.customer_response || "Updated",
      remarks: lead.remarks || "Initial renewal follow-up",
      next_action: lead.next_action_label || "",
      next_followup_date: lead.next_followup_date,
      created_at: `${todayIso()}T09:30:00+05:30`
    }));
}

// Activity Logging Logic
function logActivity(action, details, leadId = null) {
  const newActivity = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action,
    details,
    leadId,
    user: state.session?.user?.email || "Demo User"
  };
  state.activities.unshift(newActivity);
  if (state.activities.length > 100) {
    state.activities = state.activities.slice(0, 100);
  }
  localStorage.setItem(ACTIVITIES_KEY, JSON.stringify(state.activities));
  if (state.route === "activity") {
    render();
  }
}

function syncActivitiesWithFollowups() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(ACTIVITIES_KEY) || "[]");
  } catch (_) {}

  // Filter out any prior 'Follow-up Recorded' actions from local storage to prevent duplicate entries
  const localNonFollowup = saved.filter(act => act.action !== "Follow-up Recorded");

  // Re-generate database-side followups as fresh activity timeline events
  const generated = state.followups.map(f => {
    const lead = state.leads.find(l => l.id === f.renewal_id);
    const customer = lead ? lead.customer_name : "Customer";
    return {
      id: f.id,
      timestamp: f.created_at || new Date().toISOString(),
      action: "Follow-up Recorded",
      details: `Recorded ${f.followup_mode} followup for ${customer}: ${f.customer_response || f.remarks || "Updated"}`,
      leadId: f.renewal_id,
      user: f.followup_by || "Staff"
    };
  });

  // Merge, sort, and slice down to 100
  const merged = [...localNonFollowup, ...generated];
  merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  state.activities = merged.slice(0, 100);
  localStorage.setItem(ACTIVITIES_KEY, JSON.stringify(state.activities));
}

function render() {
  if (state.mode === "loading") {
    app.innerHTML = `
      <div class="boot-screen">
        <div class="loader"></div>
        <p>Loading dashboard</p>
      </div>
    `;
    return;
  }

  if (state.mode === "setup") {
    renderSetup();
    return;
  }

  if (state.mode === "auth") {
    renderAuth();
    return;
  }

  renderShell();
}

function renderSetup() {
  const showDev = state.showDevConfig;
  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-panel">
        <div class="brand-mark"><img src="./assets/images/logo.png" alt="IRFD Logo"></div>
        <h1>Portal Setup Required</h1>
        <p class="muted">This portal is not yet connected to a live database. Please configure your Supabase connection parameters in your <code>index.html</code> script block to activate this service.</p>
        
        ${renderToast()}
        
        ${showDev ? `
          <form id="config-form" class="stack-form" style="margin-top: 20px;">
            <label>
              <span>Supabase URL</span>
              <input name="url" type="url" placeholder="https://project.supabase.co" required>
            </label>
            <label>
              <span>Anon public key</span>
              <textarea name="anonKey" rows="3" placeholder="Paste your anon public key" required></textarea>
            </label>
            <button class="primary-btn" type="submit"><i data-lucide="plug"></i><span>Save Connection</span></button>
          </form>
        ` : `
          <div class="auth-actions" style="margin-top: 20px; gap: 8px; flex-direction: column; width: 100%;">
            <button class="primary-btn" type="button" data-action="preview-demo" style="width: 100%;"><i data-lucide="monitor-play"></i><span>Preview Demo Mode</span></button>
            <button class="ghost-btn" type="button" data-action="toggle-dev-config" style="width: 100%;"><i data-lucide="settings"></i><span>Developer Configuration</span></button>
          </div>
        `}
      </section>
    </main>
  `;
  bindCommonEvents();
}

function renderAuth() {
  const isLogin = state.authMode === "login";
  app.innerHTML = `
    <main class="auth-page">
      <section class="auth-panel">
        <div class="brand-mark"><img src="./assets/images/logo.png" alt="IRFD Logo"></div>
        <h1>Staff Login</h1>
        <p class="muted">Insurance Renewal Follow-up Directory Access Portal</p>
        
        <div class="auth-toggle">
          <button class="auth-toggle-btn ${isLogin ? "active" : ""}" type="button" data-auth-mode="login">Login</button>
          <button class="auth-toggle-btn ${!isLogin ? "active" : ""}" type="button" data-auth-mode="signup">Register</button>
        </div>

        ${renderToast()}

        ${isLogin ? `
          <form id="login-form" class="stack-form">
            <label>
              <span>Email</span>
              <input name="email" type="email" autocomplete="email" placeholder="agent@irfd.com" required>
            </label>
            <label>
              <span>Password</span>
              <input name="password" type="password" autocomplete="current-password" placeholder="••••••••" required>
            </label>
            <button class="primary-btn" type="submit" ${state.busy ? "disabled" : ""}><i data-lucide="log-in"></i><span>${state.busy ? "Logging in..." : "Login"}</span></button>
          </form>
        ` : `
          <form id="signup-form" class="stack-form">
            <label>
              <span>Email</span>
              <input name="email" type="email" placeholder="agent@irfd.com" required>
            </label>
            <label>
              <span>Executive Name</span>
              <input name="executive" type="text" placeholder="e.g. Ravi Kumar" required>
            </label>
            <label>
              <span>Password</span>
              <input name="password" type="password" placeholder="Min. 6 characters" required>
            </label>
            <button class="primary-btn" type="submit" ${state.busy ? "disabled" : ""}><i data-lucide="user-plus"></i><span>${state.busy ? "Registering..." : "Register"}</span></button>
          </form>
        `}

        <div class="auth-actions">
          ${isProductionConfigured() ? "" : `
            <button class="ghost-btn" type="button" data-action="preview-demo"><i data-lucide="monitor-play"></i><span>Bypass to Demo Mode</span></button>
            <button class="ghost-btn" type="button" data-action="clear-config"><i data-lucide="settings"></i><span>Change Connection</span></button>
          `}
        </div>
      </section>
    </main>
  `;
  bindCommonEvents();
}

function renderShell() {
  const selectedLead = getSelectedLead();
  app.innerHTML = `
    <div class="dashboard-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img src="./assets/images/logo.png" alt="IRFD Logo">
          <div>
            <strong>IRFD</strong>
            <span>Insurance Renewals</span>
          </div>
        </div>
        <nav class="nav-list">
          ${navItems.map(renderNavItem).join("")}
        </nav>
      </aside>
      <div class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">${state.mode === "demo" ? "Demo preview" : "Live Supabase"}</p>
            <h1>${pageTitle()}</h1>
          </div>
          <div class="topbar-actions">
            ${state.busy ? `<span class="sync-pill"><span class="mini-loader"></span>Syncing</span>` : `<span class="sync-pill"><i data-lucide="${state.mode === "demo" ? "database" : "wifi"}"></i>${state.mode === "demo" ? "Demo Data" : "Connected"}</span>`}
            <button class="icon-btn" type="button" title="Toggle Theme" aria-label="Toggle Theme" data-action="toggle-theme">
              <i data-lucide="${state.theme === "dark" ? "sun" : "moon"}"></i>
            </button>
            <button class="icon-btn" type="button" title="Refresh" aria-label="Refresh" data-action="refresh"><i data-lucide="refresh-cw"></i></button>
            <button class="icon-btn" type="button" title="New Lead" aria-label="New Lead" data-action="new-lead"><i data-lucide="plus"></i></button>
            ${state.mode === "demo" ? `<button class="text-btn" type="button" data-action="exit-demo"><i data-lucide="log-out"></i><span>Exit Demo</span></button>` : `<button class="text-btn" type="button" data-action="logout"><i data-lucide="log-out"></i><span>Logout</span></button>`}
          </div>
        </header>
        ${renderToast()}
        ${
          state.route === "reports"
            ? renderReports()
            : state.route === "activity"
              ? renderActivityLog()
              : renderDashboardView()
        }
      </div>
      ${selectedLead ? renderLeadDetail(selectedLead) : ""}
      ${state.editingLeadId !== null ? renderLeadModal() : ""}
    </div>
  `;
  bindCommonEvents();
}

function renderNavItem(item) {
  const active = item.id === state.route ? "active" : "";
  return `
    <a class="nav-item ${active}" href="#${item.id}" data-route="${item.id}">
      <i data-lucide="${item.icon}"></i>
      <span>${escapeHtml(item.label)}</span>
    </a>
  `;
}

function pageTitle() {
  return navItems.find((item) => item.id === state.route)?.label || "Overview";
}

function renderDashboardView() {
  const counts = calculateDashboardCounts(state.leads);
  const visibleLeads = applyTableFilters(filterLeadsByView(state.leads, state.route), state.filters);

  return `
    ${renderGroupedKPIs(counts)}
    <section class="table-surface">
      <div class="table-toolbar">
        <div>
          <h2>${pageTitle()}</h2>
          <p>${visibleLeads.length} records</p>
        </div>
        <div class="filter-row">
          <label class="search-box">
            <i data-lucide="search"></i>
            <input data-filter="query" type="search" placeholder="Search" value="${escapeAttribute(state.filters.query)}">
          </label>
          <select data-filter="status">
            <option value="">All statuses</option>
            ${STATUS_OPTIONS.map((status) => `<option value="${escapeAttribute(status)}" ${state.filters.status === status ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}
          </select>
          <select data-filter="executive">
            <option value="">All executives</option>
            ${getExecutives().map((name) => `<option value="${escapeAttribute(name)}" ${state.filters.executive === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}
          </select>
          <select data-filter="sortBy">
            <option value="">Sort by</option>
            <option value="days_asc" ${state.filters.sortBy === "days_asc" ? "selected" : ""}>Days Left: Least first</option>
            <option value="days_desc" ${state.filters.sortBy === "days_desc" ? "selected" : ""}>Days Left: Most first</option>
            <option value="expiry_asc" ${state.filters.sortBy === "expiry_asc" ? "selected" : ""}>Expiry: Oldest first</option>
            <option value="expiry_desc" ${state.filters.sortBy === "expiry_desc" ? "selected" : ""}>Expiry: Newest first</option>
            <option value="priority_desc" ${state.filters.sortBy === "priority_desc" ? "selected" : ""}>Priority: High to Low</option>
            <option value="priority_asc" ${state.filters.sortBy === "priority_asc" ? "selected" : ""}>Priority: Low to High</option>
            <option value="customer_asc" ${state.filters.sortBy === "customer_asc" ? "selected" : ""}>Customer: A to Z</option>
            <option value="customer_desc" ${state.filters.sortBy === "customer_desc" ? "selected" : ""}>Customer: Z to A</option>
          </select>
          <button class="ghost-btn" type="button" data-action="export-leads" title="Export to Excel" style="min-height: 40px; border-radius: 20px; padding: 0 16px;">
            <i data-lucide="download"></i><span>Export</span>
          </button>
        </div>
      </div>
      ${renderLeadTable(visibleLeads)}
    </section>
  `;
}

function renderGroupedKPIs(counts) {
  // Primary high-level metrics
  const primaryKPIs = [
    { label: "Follow-up Due Today", value: counts.followUpDueToday, icon: "phone-call", class: "kpi-today" },
    { label: "Expiring in 7 Days", value: counts.expiringIn7Days, icon: "alarm-clock", class: "kpi-expiring" },
    { label: "Action Missing", value: counts.actionMissing, icon: "alert-triangle", class: "kpi-missing" },
    { label: "Renewed Policies", value: counts.renewed, icon: "badge-check", class: "kpi-renewed" }
  ];

  // Secondary metrics in collapsible insights bar
  const secondaryInsights = [
    { label: "Total Leads", value: counts.totalRenewalLeads },
    { label: "Expiring This Month", value: counts.expiringThisMonth },
    { label: "Quote Sent", value: counts.quoteSent },
    { label: "Interested", value: counts.interestedCustomers },
    { label: "Not Interested", value: counts.notInterested },
    { label: "Lost Leads", value: counts.lost },
    { label: "Pending Follow-up", value: counts.pendingFollowup }
  ];

  return `
    <section class="kpi-row">
      ${primaryKPIs
        .map(
          (kpi) => `
            <article class="kpi-card ${kpi.class}">
              <div class="kpi-header">
                <span>${escapeHtml(kpi.label)}</span>
                <div class="kpi-icon"><i data-lucide="${kpi.icon}"></i></div>
              </div>
              <strong>${kpi.value}</strong>
            </article>
          `
        )
        .join("")}
    </section>

    <button type="button" class="insights-toggle-btn ${state.insightsExpanded ? "expanded" : ""}" data-action="toggle-insights">
      <i data-lucide="chevron-down"></i>
      <span>Secondary Metrics & Insights</span>
    </button>

    <section class="insights-panel ${state.insightsExpanded ? "expanded" : ""}">
      <div class="insights-grid">
        ${secondaryInsights
          .map(
            (ins) => `
              <article class="insight-card">
                <span>${escapeHtml(ins.label)}</span>
                <strong>${ins.value}</strong>
              </article>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderLeadTable(leads) {
  if (!leads.length) {
    return `<div class="empty-state"><i data-lucide="inbox"></i><p>No records found</p></div>`;
  }

  return `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Customer</th>
            <th>Vehicle</th>
            <th>Mobile</th>
            <th>Expiry</th>
            <th>Days</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Next Action</th>
            <th>Assigned To</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${leads.map(renderLeadRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderLeadRow(lead) {
  const decorated = decorateLead(lead);
  return `
    <tr>
      <td>
        <strong>${escapeHtml(decorated.customer_name)}</strong>
        <span>${escapeHtml(decorated.current_insurer || "Unknown insurer")}</span>
      </td>
      <td>
        <strong>${escapeHtml(decorated.vehicle_number)}</strong>
        <span>${escapeHtml([decorated.model, decorated.variant].filter(Boolean).join(" / "))}</span>
      </td>
      <td>${escapeHtml(decorated.mobile_number)}</td>
      <td>${formatDate(decorated.policy_expiry_date)}</td>
      <td>${decorated.days_left ?? "-"}</td>
      <td><span class="priority-pill ${decorated.priority_class}">${escapeHtml(decorated.priority)}</span></td>
      <td><span class="status-pill">${escapeHtml(decorated.current_status)}</span></td>
      <td class="${decorated.action_missing ? "action-missing" : ""}">${escapeHtml(decorated.next_action_label)}</td>
      <td>${escapeHtml(decorated.assigned_executive || "Unassigned")}</td>
      <td>
        <div class="action-cell-container">
          <div class="row-actions">
            <button type="button" title="Call" data-call="${escapeAttribute(decorated.mobile_number)}"><i data-lucide="phone"></i></button>
            <button type="button" title="WhatsApp" data-whatsapp="${escapeAttribute(decorated.mobile_number)}"><i data-lucide="message-circle"></i></button>
            <button type="button" title="Quick Edit" data-quick-edit="${decorated.id}"><i data-lucide="pencil"></i></button>
          </div>
          <button class="icon-btn small btn-open-drawer" type="button" title="Open" aria-label="Open" data-select-lead="${decorated.id}"><i data-lucide="panel-right-open"></i></button>
        </div>
      </td>
    </tr>
  `;
}

function renderLeadDetail(lead) {
  const decorated = decorateLead(lead);
  const history = state.followups.filter((followup) => followup.renewal_id === lead.id).slice(0, 6);

  const tabClass = (tab) => (state.detailTab === tab ? "active" : "");

  return `
    <aside class="detail-panel">
      <div class="detail-header">
        <div>
          <p class="eyebrow">${escapeHtml(decorated.vehicle_number)}</p>
          <h2>${escapeHtml(decorated.customer_name)}</h2>
        </div>
        <button class="icon-btn" type="button" title="Close" aria-label="Close" data-action="close-detail"><i data-lucide="x"></i></button>
      </div>

      <div class="detail-actions">
        <button class="ghost-btn" type="button" data-action="edit-lead"><i data-lucide="pencil"></i><span>Edit Lead</span></button>
        <button class="ghost-btn" type="button" data-call="${escapeAttribute(decorated.mobile_number)}"><i data-lucide="phone"></i><span>Call</span></button>
        <button class="ghost-btn" type="button" data-whatsapp="${escapeAttribute(decorated.mobile_number)}"><i data-lucide="message-circle"></i><span>WhatsApp</span></button>
      </div>

      <nav class="detail-tabs">
        <button type="button" class="detail-tab-btn ${tabClass("overview")}" data-detail-tab="overview">Overview</button>
        <button type="button" class="detail-tab-btn ${tabClass("followup")}" data-detail-tab="followup">Interaction</button>
        <button type="button" class="detail-tab-btn ${tabClass("history")}" data-detail-tab="history">Timeline</button>
      </nav>

      <!-- TAB: Overview -->
      <section class="detail-tab-content ${tabClass("overview")}">
        <dl class="detail-list">
          ${detailItem("Status", decorated.current_status)}
          ${detailItem("Priority", decorated.priority)}
          ${detailItem("Expiry Date", formatDate(decorated.policy_expiry_date))}
          ${detailItem("Days Left", decorated.days_left ?? "-")}
          ${detailItem("Quote", formatCurrency(decorated.renewal_quote_amount))}
          ${detailItem("IDV", formatCurrency(decorated.idv))}
          ${detailItem("Policy Type", decorated.policy_type || "-")}
          ${detailItem("Next Follow-up", formatDate(decorated.next_followup_date))}
          ${detailItem("Assigned", decorated.assigned_executive || "Unassigned")}
          ${detailItem("Current Insurer", decorated.current_insurer || "-")}
        </dl>
      </section>

      <!-- TAB: Follow-up -->
      <section class="detail-tab-content ${tabClass("followup")}">
        <div class="quick-actions">
          ${["Quote Sent", "Interested", "Payment Pending", "Renewed", "Lost"].map((status) => `<button type="button" data-quick-status="${escapeAttribute(status)}">${escapeHtml(status)}</button>`).join("")}
        </div>
        <form id="followup-form" class="followup-form">
          <div class="form-grid">
            <label>
              <span>Status</span>
              <select name="current_status">
                ${STATUS_OPTIONS.map((status) => `<option value="${escapeAttribute(status)}" ${decorated.current_status === status ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}
              </select>
            </label>
            <label>
              <span>Mode</span>
              <select name="followup_mode">
                ${FOLLOWUP_MODES.map((mode) => `<option value="${escapeAttribute(mode)}">${escapeHtml(mode)}</option>`).join("")}
              </select>
            </label>
            <label>
              <span>Follow-up Date</span>
              <input name="followup_date" type="date" value="${todayIso()}">
            </label>
            <label>
              <span>Next Follow-up</span>
              <input name="next_followup_date" type="date" value="${escapeAttribute(decorated.next_followup_date || "")}">
            </label>
            <label>
              <span>Payment</span>
              <select name="payment_status">
                ${PAYMENT_STATUS_OPTIONS.map((payment) => `<option value="${escapeAttribute(payment)}" ${decorated.payment_status === payment ? "selected" : ""}>${escapeHtml(payment)}</option>`).join("")}
              </select>
            </label>
            <label>
              <span>Renewal Date</span>
              <input name="renewal_date" type="date" value="${escapeAttribute(decorated.renewal_date || "")}">
            </label>
            <label>
              <span>Lost Reason</span>
              <select name="lost_reason">
                <option value="">None</option>
                ${LOST_REASONS.map((reason) => `<option value="${escapeAttribute(reason)}" ${decorated.lost_reason === reason ? "selected" : ""}>${escapeHtml(reason)}</option>`).join("")}
              </select>
            </label>
            <label>
              <span>Next Action</span>
              <input name="next_action" type="text" value="${escapeAttribute(decorated.next_action_label === "Action Missing" ? "" : decorated.next_action_label)}">
            </label>
          </div>
          <label>
            <span>Customer Response</span>
            <textarea name="customer_response" rows="2">${escapeHtml(decorated.customer_response || "")}</textarea>
          </label>
          <label>
            <span>Remarks</span>
            <textarea name="remarks" rows="2">${escapeHtml(decorated.remarks || "")}</textarea>
          </label>
          <button class="primary-btn" type="submit"><i data-lucide="save"></i><span>Save Follow-up</span></button>
        </form>
      </section>

      <!-- TAB: History -->
      <section class="detail-tab-content ${tabClass("history")} history-list">
        <h3>Follow-up Timeline</h3>
        ${history.length ? history.map(renderHistoryItem).join("") : `<p class="muted">No follow-up history yet.</p>`}
      </section>
    </aside>
  `;
}

function detailItem(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "-")}</dd></div>`;
}

function renderHistoryItem(item) {
  return `
    <article>
      <strong>${formatDate(item.followup_date)} - ${escapeHtml(item.followup_mode || "Follow-up")}</strong>
      <p>${escapeHtml(item.customer_response || item.remarks || "Updated")}</p>
      <span>${escapeHtml(item.followup_by || "Staff")}</span>
    </article>
  `;
}

/* Reports view: rendering SVG charts */
function renderReports() {
  const funnel = state.reportViews?.funnel || calculateFunnel(state.leads);
  const staff = state.reportViews?.staff || calculateStaffPerformance(state.leads, state.followups);
  const insurers = state.reportViews?.insurers || calculateInsurerPerformance(state.leads);
  const lostReasons = state.reportViews?.lostReasons || calculateLostReasonSummary(state.leads);
  const monthly = state.reportViews?.monthly || calculateMonthlyReport(state.leads);

  return `
    <section class="reports-grid">
      <!-- Funnel Chart SVG -->
      <section class="report-card">
        <h2>Conversion Funnel</h2>
        <div class="chart-container">
          ${renderFunnelSvg(funnel)}
        </div>
      </section>

      <!-- Monthly Trend Line SVG -->
      <section class="report-card">
        <h2>Month-wise Premium (Renewed)</h2>
        <div class="chart-container">
          ${renderMonthlyTrendSvg(monthly)}
        </div>
      </section>

      <!-- Staff Performance Bar SVG -->
      <section class="report-card">
        <h2>Staff Conversion Performance</h2>
        <div class="chart-container">
          ${renderStaffPerformanceSvg(staff)}
        </div>
      </section>

      <!-- Insurer Share Pie/Bar SVG -->
      <section class="report-card">
        <h2>Insurers Conversion Ratio</h2>
        <div class="chart-container">
          ${renderInsurerPerformanceSvg(insurers)}
        </div>
      </section>
    </section>
  `;
}

/* SVG Funnel Chart Helper */
function renderFunnelSvg(funnel = []) {
  if (!funnel.length) return `<p class="muted">No data</p>`;
  
  const width = 450;
  const height = 220;
  const maxCount = Math.max(...funnel.map(d => d.count)) || 1;
  const rowHeight = height / funnel.length;
  
  let svgContent = `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  
  // Gradients for funnel
  svgContent += `
    <defs>
      <linearGradient id="funnel-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#aca1e3" />
        <stop offset="100%" stop-color="#8b7bdc" />
      </linearGradient>
    </defs>
  `;
  
  funnel.forEach((row, idx) => {
    const nextRow = funnel[idx + 1];
    
    // Widths based on counts
    const w1 = maxCount ? (row.count / maxCount) * (width * 0.7) : 0;
    const w2 = nextRow ? (maxCount ? (nextRow.count / maxCount) * (width * 0.7) : 0) : w1 * 0.8;
    
    const x1_left = (width - w1) / 2;
    const x1_right = x1_left + w1;
    const x2_left = (width - w2) / 2;
    const x2_right = x2_left + w2;
    
    const y1 = idx * rowHeight;
    const y2 = y1 + rowHeight - 6; // slightly smaller to create gaps
    
    const points = `${x1_left},${y1} ${x1_right},${y1} ${x2_right},${y2} ${x2_left},${y2}`;
    
    // Funnel polygon slice
    svgContent += `<polygon points="${points}" class="funnel-stage-fill" />`;
    
    // Add text label and count
    const labelY = y1 + (rowHeight / 2) - 1;
    svgContent += `
      <text x="${width / 2}" y="${labelY}" class="chart-text" font-weight="700" fill="#ffffff" text-anchor="middle" font-size="11px">${escapeHtml(row.stage)}: ${row.count}</text>
    `;
  });
  
  svgContent += `</svg>`;
  return svgContent;
}

/* SVG Line Trend Helper */
function renderMonthlyTrendSvg(monthly = []) {
  if (!monthly.length) return `<p class="muted">No monthly premium trend data</p>`;
  
  const width = 450;
  const height = 220;
  const padding = 35;
  
  const maxPremium = Math.max(...monthly.map(d => Number(d.premium_total))) || 1;
  const pointsCount = monthly.length;
  
  const stepX = (width - padding * 2) / (pointsCount > 1 ? pointsCount - 1 : 1);
  
  let pathD = "";
  let areaD = "";
  let circles = "";
  let xLabels = "";
  
  monthly.forEach((d, idx) => {
    const x = padding + idx * stepX;
    const ratio = maxPremium ? Number(d.premium_total) / maxPremium : 0;
    const y = height - padding - ratio * (height - padding * 2);
    
    if (idx === 0) {
      pathD += `M ${x} ${y}`;
      areaD += `M ${x} ${height - padding} L ${x} ${y}`;
    } else {
      pathD += ` L ${x} ${y}`;
    }
    
    if (idx === pointsCount - 1) {
      areaD += ` L ${x} ${y} L ${x} ${height - padding} Z`;
    } else if (idx > 0) {
      areaD += ` L ${x} ${y}`;
    }
    
    // Add dots
    circles += `<circle cx="${x}" cy="${y}" r="4" class="chart-point" title="${d.month}: ${formatCurrency(d.premium_total)}"></circle>`;
    
    // Labels (only plot first, middle, last to prevent overlap)
    if (idx === 0 || idx === pointsCount - 1 || (pointsCount > 4 && idx === Math.floor(pointsCount / 2))) {
      xLabels += `<text x="${x}" y="${height - 12}" class="chart-text" text-anchor="middle">${d.month}</text>`;
    }
  });

  if (pointsCount === 1) {
    const x = width / 2;
    const ratio = maxPremium ? Number(monthly[0].premium_total) / maxPremium : 0;
    const y = height - padding - ratio * (height - padding * 2);
    circles = `<circle cx="${x}" cy="${y}" r="4" class="chart-point"></circle>`;
    xLabels = `<text x="${x}" y="${height - 12}" class="chart-text" text-anchor="middle">${monthly[0].month}</text>`;
  }
  
  let svgContent = `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  
  // Grid and gradients definitions
  svgContent += `
    <defs>
      <linearGradient id="area-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#8b7bdc" stop-opacity="0.35" />
        <stop offset="100%" stop-color="#8b7bdc" stop-opacity="0" />
      </linearGradient>
    </defs>
    
    <!-- Y Axis grid lines -->
    <line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" class="chart-grid-line" />
    <line x1="${padding}" y1="${(height - padding * 2) / 2 + padding}" x2="${width - padding}" y2="${(height - padding * 2) / 2 + padding}" class="chart-grid-line" />
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" class="chart-axis-line" />
  `;
  
  if (pointsCount > 1) {
    svgContent += `
      <path d="${areaD}" class="chart-area-path" />
      <path d="${pathD}" class="chart-line-path" />
    `;
  }
  
  svgContent += circles + xLabels + `</svg>`;
  return svgContent;
}

/* SVG Staff Performance Bar Chart Helper */
function renderStaffPerformanceSvg(staff = []) {
  if (!staff.length) return `<p class="muted">No staff performance data</p>`;
  
  const width = 450;
  const height = 220;
  const paddingLeft = 90;
  const paddingRight = 45;
  const paddingTop = 15;
  const paddingBottom = 15;
  
  const maxLeads = Math.max(...staff.map(s => s.leads_assigned)) || 1;
  const barChartHeight = height - paddingTop - paddingBottom;
  const barRowHeight = barChartHeight / staff.length;
  
  let svgContent = `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  
  staff.forEach((advisor, idx) => {
    const y = paddingTop + idx * barRowHeight;
    const barHeight = Math.max(8, barRowHeight - 12);
    const labelY = y + (barRowHeight / 2) + 3;
    
    const maxWidth = width - paddingLeft - paddingRight;
    const wLeads = maxLeads ? (advisor.leads_assigned / maxLeads) * maxWidth : 0;
    const wRenewed = maxLeads ? (advisor.renewed / maxLeads) * maxWidth : 0;
    
    // Draw Name
    svgContent += `<text x="${paddingLeft - 10}" y="${labelY}" class="chart-text" text-anchor="end" font-weight="600">${escapeHtml(advisor.executive)}</text>`;
    
    // Draw Background Bar for Total Leads
    svgContent += `<rect x="${paddingLeft}" y="${y + 2}" width="${maxWidth}" height="${barHeight}" rx="4" fill="rgba(166, 166, 178, 0.08)" />`;
    // Draw Leads Assigned Bar
    svgContent += `<rect x="${paddingLeft}" y="${y + 2}" width="${wLeads}" height="${barHeight}" rx="4" fill="rgba(139, 123, 220, 0.2)" />`;
    // Draw Renewed Bar on top
    svgContent += `<rect x="${paddingLeft}" y="${y + 2}" width="${wRenewed}" height="${barHeight}" rx="4" fill="#8b7bdc" />`;
    
    // Draw conversion percentage text
    svgContent += `<text x="${paddingLeft + wLeads + 8}" y="${labelY}" class="chart-text" font-weight="700" fill="#8b7bdc">${advisor.conversion_percentage}%</text>`;
  });
  
  // Y Axis divider line
  svgContent += `<line x1="${paddingLeft - 4}" y1="${paddingTop}" x2="${paddingLeft - 4}" y2="${height - paddingBottom}" class="chart-axis-line" />`;
  svgContent += `</svg>`;
  return svgContent;
}

/* SVG Insurer Conversion Performance Bar Chart Helper */
function renderInsurerPerformanceSvg(insurers = []) {
  if (!insurers.length) return `<p class="muted">No insurer conversion data</p>`;
  
  // Take top 5 insurers by leads
  const data = insurers.sort((a, b) => b.leads - a.leads).slice(0, 5);
  
  const width = 450;
  const height = 220;
  const paddingLeft = 100;
  const paddingRight = 45;
  const paddingTop = 15;
  const paddingBottom = 15;
  
  const maxRatio = Math.max(...data.map(i => i.conversion_percentage)) || 100;
  const barChartHeight = height - paddingTop - paddingBottom;
  const barRowHeight = barChartHeight / data.length;
  
  let svgContent = `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  
  data.forEach((ins, idx) => {
    const y = paddingTop + idx * barRowHeight;
    const barHeight = Math.max(8, barRowHeight - 12);
    const labelY = y + (barRowHeight / 2) + 3;
    
    const maxWidth = width - paddingLeft - paddingRight;
    const wBar = maxRatio ? (ins.conversion_percentage / 100) * maxWidth : 0;
    
    // Draw Name
    svgContent += `<text x="${paddingLeft - 10}" y="${labelY}" class="chart-text" text-anchor="end" font-weight="600">${escapeHtml(ins.insurance_company)}</text>`;
    
    // Background Track Bar
    svgContent += `<rect x="${paddingLeft}" y="${y + 2}" width="${maxWidth}" height="${barHeight}" rx="4" fill="rgba(166, 166, 178, 0.08)" />`;
    // Conversion Value Bar
    svgContent += `<rect x="${paddingLeft}" y="${y + 2}" width="${wBar}" height="${barHeight}" rx="4" fill="#8b7bdc" />`;
    
    // Percentage Value Text
    svgContent += `<text x="${paddingLeft + wBar + 8}" y="${labelY}" class="chart-text" font-weight="700" fill="#8b7bdc">${ins.conversion_percentage}%</text>`;
  });
  
  // Y Axis divider line
  svgContent += `<line x1="${paddingLeft - 4}" y1="${paddingTop}" x2="${paddingLeft - 4}" y2="${height - paddingBottom}" class="chart-axis-line" />`;
  svgContent += `</svg>`;
  return svgContent;
}

/* NEW: Activity Log View Helper */
function renderActivityLog() {
  if (!state.activities.length) {
    return `<div class="empty-state"><i data-lucide="clipboard-list"></i><p>No activity logged yet.</p></div>`;
  }

  return `
    <section class="table-surface" style="padding: 24px;">
      <div class="table-toolbar" style="padding: 0 0 20px; border-bottom: 1px solid var(--line); margin-bottom: 20px;">
        <div>
          <h2>System Activity Log</h2>
          <p>Showing last ${state.activities.length} operations performed on this dashboard</p>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="ghost-btn" type="button" data-action="export-activities" title="Export Activity Log">
            <i data-lucide="download"></i><span>Export</span>
          </button>
          <button class="ghost-btn" type="button" data-action="clear-activities">
            <i data-lucide="trash-2"></i><span>Clear Local Log</span>
          </button>
        </div>
      </div>
      <div class="activity-timeline">
        ${state.activities.map(renderActivityItem).join("")}
      </div>
    </section>
  `;
}

function renderActivityItem(act) {
  let icon = "info";
  if (act.action.includes("Login")) icon = "log-in";
  if (act.action.includes("Logout")) icon = "log-out";
  if (act.action.includes("Created")) icon = "plus-circle";
  if (act.action.includes("Updated") || act.action.includes("Edit")) icon = "edit-3";
  if (act.action.includes("Follow-up")) icon = "phone-call";
  if (act.action.includes("Theme")) icon = "sun";
  if (act.action.includes("Connection")) icon = "settings";

  const timeStr = formatActivityTime(act.timestamp);

  return `
    <article class="activity-item" ${act.leadId ? `data-select-lead="${act.leadId}" style="cursor: pointer;"` : ""}>
      <div class="activity-icon"><i data-lucide="${icon}"></i></div>
      <div class="activity-content">
        <div class="activity-meta">
          <strong>${escapeHtml(act.action)}</strong>
          <span>${timeStr}</span>
        </div>
        <p class="activity-desc">${escapeHtml(act.details)}</p>
        <span class="activity-user">By: ${escapeHtml(act.user)}</span>
      </div>
    </article>
  `;
}

function formatActivityTime(timestamp) {
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return "-";
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;

    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, "0");
    const mins = String(date.getMinutes()).padStart(2, "0");
    return `${day}-${month}-${year} ${hours}:${mins}`;
  } catch (_) {
    return "-";
  }
}

function renderLeadModal() {
  const isNew = state.editingLeadId === "new";
  const lead = isNew ? getBlankLead() : state.leads.find((item) => item.id === state.editingLeadId);
  if (!lead) return "";

  return `
    <div class="modal-backdrop">
      <form id="lead-form" class="lead-modal">
        <div class="modal-header">
          <div>
            <p class="eyebrow">${isNew ? "New record" : "Edit record"}</p>
            <h2>${isNew ? "Renewal Lead" : escapeHtml(lead.customer_name)}</h2>
          </div>
          <button class="icon-btn" type="button" title="Close" aria-label="Close" data-action="close-modal"><i data-lucide="x"></i></button>
        </div>
        <div class="form-grid wide">
          ${inputField("Customer Name", "customer_name", lead.customer_name, "text", true)}
          ${inputField("Mobile Number", "mobile_number", lead.mobile_number, "tel", true)}
          ${inputField("Vehicle Number", "vehicle_number", lead.vehicle_number, "text", true)}
          ${inputField("Model", "model", lead.model)}
          ${inputField("Variant", "variant", lead.variant)}
          ${inputField("Registration Date", "registration_date", lead.registration_date, "date")}
          ${inputField("Service Advisor", "service_advisor", lead.service_advisor)}
          ${inputField("Relationship Manager", "relationship_manager", lead.relationship_manager)}
          ${inputField("Current Insurer", "current_insurer", lead.current_insurer)}
          ${inputField("Policy Number", "policy_number", lead.policy_number)}
          ${inputField("Policy Expiry Date", "policy_expiry_date", lead.policy_expiry_date, "date", true)}
          ${inputField("Previous Premium", "previous_premium", lead.previous_premium, "number")}
          ${inputField("Renewal Quote", "renewal_quote_amount", lead.renewal_quote_amount, "number")}
          ${inputField("IDV", "idv", lead.idv, "number")}
          ${inputField("NCB %", "ncb_percentage", lead.ncb_percentage, "number")}
          ${selectField("Policy Type", "policy_type", lead.policy_type, ["Comprehensive", "Third Party", "Own Damage"])}
          ${selectField("Current Status", "current_status", lead.current_status, STATUS_OPTIONS)}
          ${selectField("Payment Status", "payment_status", lead.payment_status, PAYMENT_STATUS_OPTIONS)}
          ${inputField("Quote Sent Date", "quote_sent_date", lead.quote_sent_date, "date")}
          ${inputField("Renewal Date", "renewal_date", lead.renewal_date, "date")}
          ${inputField("Last Follow-up", "last_followup_date", lead.last_followup_date, "date")}
          ${inputField("Next Follow-up", "next_followup_date", lead.next_followup_date, "date")}
          ${inputField("Assigned Executive", "assigned_executive", lead.assigned_executive)}
          ${selectField("Lost Reason", "lost_reason", lead.lost_reason, ["", ...LOST_REASONS])}
        </div>
        <label>
          <span>Add-ons</span>
          <input name="addons" type="text" value="${escapeAttribute(Array.isArray(lead.addons) ? lead.addons.join(", ") : lead.addons || "")}">
        </label>
        <label>
          <span>Customer Response</span>
          <textarea name="customer_response" rows="2">${escapeHtml(lead.customer_response || "")}</textarea>
        </label>
        <label>
          <span>Remarks</span>
          <textarea name="remarks" rows="2">${escapeHtml(lead.remarks || "")}</textarea>
        </label>
        <div class="modal-actions">
          <button class="ghost-btn" type="button" data-action="close-modal">Cancel</button>
          <button class="primary-btn" type="submit"><i data-lucide="save"></i><span>Save Lead</span></button>
        </div>
      </form>
    </div>
  `;
}

function inputField(label, name, value = "", type = "text", required = false) {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input name="${escapeAttribute(name)}" type="${type}" value="${escapeAttribute(value || "")}" ${required ? "required" : ""}>
    </label>
  `;
}

function selectField(label, name, value, options) {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <select name="${escapeAttribute(name)}">
        ${options.map((option) => `<option value="${escapeAttribute(option)}" ${value === option ? "selected" : ""}>${escapeHtml(option || "None")}</option>`).join("")}
      </select>
    </label>
  `;
}

function getBlankLead() {
  return {
    customer_name: "",
    mobile_number: "",
    vehicle_number: "",
    model: "",
    variant: "",
    registration_date: "",
    service_advisor: "",
    relationship_manager: "",
    current_insurer: "",
    policy_number: "",
    policy_expiry_date: todayIso(),
    previous_premium: "",
    renewal_quote_amount: "",
    idv: "",
    ncb_percentage: "",
    policy_type: "Comprehensive",
    addons: [],
    current_status: "New Lead",
    customer_response: "",
    lost_reason: "",
    last_followup_date: "",
    next_followup_date: todayIso(),
    assigned_executive: "",
    payment_status: "Not Started",
    quote_sent_date: "",
    renewal_date: "",
    remarks: ""
  };
}

function bindCommonEvents() {
  window.lucide?.createIcons();

  document.querySelector("#config-form")?.addEventListener("submit", handleConfigSubmit);
  document.querySelector("#login-form")?.addEventListener("submit", handleLogin);
  document.querySelector("#signup-form")?.addEventListener("submit", handleSignUp);
  document.querySelector("#followup-form")?.addEventListener("submit", handleFollowupSubmit);
  document.querySelector("#lead-form")?.addEventListener("submit", handleLeadSubmit);

  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.authMode = button.dataset.authMode;
      state.toast = null;
      render();
    });
  });

  document.querySelectorAll("[data-filter]").forEach((field) => {
    const handler = () => {
      state.filters[field.dataset.filter] = field.value;
      render();
    };
    field.addEventListener("input", handler);
    field.addEventListener("change", handler);
  });

  document.querySelectorAll("[data-select-lead]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedLeadId = button.dataset.selectLead;
      state.detailTab = "overview";
      render();
    });
  });

  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.detailTab = button.dataset.detailTab;
      render();
    });
  });

  document.querySelectorAll("[data-quick-status]").forEach((button) => {
    button.addEventListener("click", () => applyQuickStatus(button.dataset.quickStatus));
  });

  document.querySelectorAll("[data-quick-edit]").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      state.editingLeadId = button.dataset.quickEdit;
      render();
    });
  });

  document.querySelectorAll("[data-call]").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      window.location.href = `tel:${button.dataset.call}`;
    });
  });

  document.querySelectorAll("[data-whatsapp]").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open(`https://wa.me/91${String(button.dataset.whatsapp).replace(/\D/g, "").slice(-10)}`, "_blank", "noopener");
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", handleAction);
  });
}

async function handleAction(event) {
  const action = event.currentTarget.dataset.action;
  if (action === "toggle-dev-config") {
    state.showDevConfig = !state.showDevConfig;
    render();
    return;
  }
  if (action === "preview-demo") enableDemoMode();
  if (action === "clear-config") {
    localStorage.removeItem(CONFIG_KEY);
    localStorage.removeItem(DEMO_ENABLED_KEY);
    logActivity("Connection Cleared", "Removed Supabase credentials from local memory.");
    window.location.reload();
  }
  if (action === "exit-demo") {
    localStorage.removeItem(DEMO_ENABLED_KEY);
    state.mode = hasSupabaseConfig(getStoredConfig()) ? "auth" : "setup";
    state.leads = [];
    state.followups = [];
    logActivity("Demo Exit", "Closed local demo workspace.");
    render();
  }
  if (action === "logout") {
    logActivity("Staff Logout", `Active session ended for user.`);
    await state.client?.auth.signOut();
  }
  if (action === "refresh") {
    if (state.mode === "demo") {
      state.toast = { type: "info", message: "Demo data is current." };
      render();
    } else {
      await loadData();
    }
  }
  if (action === "new-lead") {
    state.editingLeadId = "new";
    render();
  }
  if (action === "edit-lead") {
    state.editingLeadId = state.selectedLeadId;
    render();
  }
  if (action === "close-detail") {
    state.selectedLeadId = null;
    render();
  }
  if (action === "close-modal") {
    state.editingLeadId = null;
    render();
  }
  if (action === "toggle-insights") {
    state.insightsExpanded = !state.insightsExpanded;
    localStorage.setItem(INSIGHTS_KEY, state.insightsExpanded);
    render();
  }
  if (action === "toggle-theme") {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, state.theme);
    applyTheme();
    logActivity("Theme Changed", `Toggled interface visual mode to ${state.theme.toUpperCase()} theme.`);
    render();
  }
  if (action === "clear-activities") {
    state.activities = [];
    localStorage.removeItem(ACTIVITIES_KEY);
    logActivity("Logs Cleared", "Manual wipe of local system activities log.");
    render();
  }
  if (action === "export-leads") {
    exportLeadsToCsv();
  }
  if (action === "export-activities") {
    exportActivitiesToCsv();
  }
}

function handleConfigSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const config = {
    url: String(form.get("url") || "").trim(),
    anonKey: String(form.get("anonKey") || "").trim()
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  localStorage.removeItem(DEMO_ENABLED_KEY);
  
  // Set up placeholder client to write initial setup activity log
  state.activities = [];
  logActivity("Connection Setup", "Saved Supabase URL and anon public key connection details.");
  window.location.reload();
}

async function handleLogin(event) {
  event.preventDefault();
  state.busy = true;
  state.toast = null;
  render();

  const form = new FormData(event.currentTarget);
  const email = String(form.get("email") || "").trim();
  const password = String(form.get("password") || "");
  const { error } = await state.client.auth.signInWithPassword({ email, password });

  if (error) {
    state.busy = false;
    state.toast = { type: "error", message: error.message };
    render();
  }
}

async function handleSignUp(event) {
  event.preventDefault();
  state.busy = true;
  state.toast = null;
  render();

  const form = new FormData(event.currentTarget);
  const email = String(form.get("email") || "").trim();
  const password = String(form.get("password") || "");
  const executive = String(form.get("executive") || "").trim();

  if (!state.client) {
    // Simulate signup successfully if client is not connected
    setTimeout(() => {
      state.busy = false;
      state.toast = { type: "success", message: `Registry override simulated! Registered profile for ${executive}.` };
      state.authMode = "login";
      render();
    }, 1200);
    return;
  }

  const { data, error } = await state.client.auth.signUp({
    email,
    password,
    options: {
      data: {
        assigned_executive: executive
      }
    }
  });

  if (error) {
    state.busy = false;
    state.toast = { type: "error", message: error.message };
    render();
  } else {
    state.busy = false;
    state.toast = { 
      type: "success", 
      message: data.user?.identities?.length === 0 
        ? "Access registration successful. Check your email for validation instructions." 
        : "Staff profile committed! Verification email has been transmitted." 
    };
    state.authMode = "login";
    render();
  }
}

async function handleFollowupSubmit(event) {
  event.preventDefault();
  const selected = getSelectedLead();
  if (!selected) return;

  const form = new FormData(event.currentTarget);
  const payload = {
    renewal_id: selected.id,
    followup_date: nullable(form.get("followup_date")) || todayIso(),
    followup_by: state.session?.user?.email || "Demo User",
    followup_mode: nullable(form.get("followup_mode")) || "Call",
    current_status: nullable(form.get("current_status")) || selected.current_status,
    customer_response: nullable(form.get("customer_response")),
    remarks: nullable(form.get("remarks")),
    next_action: nullable(form.get("next_action")),
    next_followup_date: nullable(form.get("next_followup_date")),
    payment_status: nullable(form.get("payment_status")),
    lost_reason: nullable(form.get("lost_reason")),
    renewal_date: nullable(form.get("renewal_date"))
  };

  if (state.mode === "demo") {
    recordDemoFollowup(payload);
    state.toast = { type: "success", message: "Follow-up saved." };
    state.detailTab = "history";
    
    // Log Followup activity locally in demo mode
    logActivity("Follow-up Saved", `Recorded ${payload.followup_mode} followup for ${selected.customer_name}: ${payload.customer_response || payload.remarks || "Updated"}`, payload.renewal_id);
    render();
    return;
  }

  state.busy = true;
  render();
  const { error } = await state.client.rpc("record_renewal_followup", {
    p_renewal_id: payload.renewal_id,
    p_followup_date: payload.followup_date,
    p_followup_by: payload.followup_by,
    p_followup_mode: payload.followup_mode,
    p_current_status: payload.current_status,
    p_customer_response: payload.customer_response,
    p_remarks: payload.remarks,
    p_next_action: payload.next_action,
    p_next_followup_date: payload.next_followup_date,
    p_payment_status: payload.payment_status,
    p_lost_reason: payload.lost_reason,
    p_renewal_date: payload.renewal_date
  });

  state.busy = false;
  state.toast = error ? { type: "error", message: error.message } : { type: "success", message: "Follow-up saved." };
  state.detailTab = "history";
  
  if (!error) {
    logActivity("Follow-up Saved", `Recorded ${payload.followup_mode} followup for ${selected.customer_name}: ${payload.customer_response || payload.remarks || "Updated"}`, payload.renewal_id);
  }
  await loadData();
}

async function handleLeadSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = extractLeadPayload(form);
  const isNew = state.editingLeadId === "new";

  if (state.mode === "demo") {
    const leadId = isNew ? crypto.randomUUID() : state.editingLeadId;
    if (isNew) {
      state.leads.unshift({ ...payload, id: leadId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      logActivity("Lead Created", `Created new renewal lead for ${payload.customer_name} (${payload.vehicle_number}).`, leadId);
    } else {
      state.leads = state.leads.map((lead) => (lead.id === state.editingLeadId ? { ...lead, ...payload, updated_at: new Date().toISOString() } : lead));
      logActivity("Lead Updated", `Modified details for ${payload.customer_name} (${payload.vehicle_number}).`, leadId);
    }
    state.editingLeadId = null;
    state.toast = { type: "success", message: "Lead saved." };
    persistDemo();
    render();
    return;
  }

  state.busy = true;
  render();
  const query = isNew
    ? state.client.from("insurance_renewals").insert(payload).select().single()
    : state.client.from("insurance_renewals").update(payload).eq("id", state.editingLeadId).select().single();
  const { data, error } = await query;
  
  state.busy = false;
  state.toast = error ? { type: "error", message: error.message } : { type: "success", message: "Lead saved." };
  
  if (!error && data) {
    const actionName = isNew ? "Lead Created" : "Lead Updated";
    const details = isNew 
      ? `Created new renewal lead for ${payload.customer_name} (${payload.vehicle_number}).`
      : `Modified details for ${payload.customer_name} (${payload.vehicle_number}).`;
    logActivity(actionName, details, data.id);
  }
  
  state.editingLeadId = error ? state.editingLeadId : null;
  await loadData();
}

function extractLeadPayload(form) {
  const numericFields = ["previous_premium", "renewal_quote_amount", "idv", "ncb_percentage"];
  const payload = {};
  for (const [key, value] of form.entries()) {
    if (key === "addons") {
      payload.addons = String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (numericFields.includes(key)) {
      payload[key] = value === "" ? null : Number(value);
    } else {
      payload[key] = nullable(value);
    }
  }

  if (payload.current_status === "Renewed" && !payload.renewal_date) payload.renewal_date = todayIso();
  if (isClosedStatus(payload.current_status)) payload.closed_at = new Date().toISOString();
  return payload;
}

function applyQuickStatus(status) {
  const form = document.querySelector("#followup-form");
  if (!form) return;
  form.elements.current_status.value = status;
  if (status === "Renewed") {
    form.elements.payment_status.value = "Collected";
    form.elements.renewal_date.value = todayIso();
    form.elements.next_followup_date.value = "";
    form.elements.next_action.value = "Share policy copy";
  } else if (status === "Lost") {
    form.elements.next_followup_date.value = "";
    form.elements.next_action.value = "Review lost reason";
  } else if (status === "Payment Pending") {
    form.elements.payment_status.value = "Pending";
    form.elements.next_action.value = "Collect payment";
    form.elements.next_followup_date.value = todayIso();
  } else if (status === "Quote Sent") {
    form.elements.next_action.value = "Call for confirmation";
    form.elements.next_followup_date.value = addDays(todayIso(), 1);
  } else if (status === "Interested") {
    form.elements.next_action.value = "Push for payment";
    form.elements.next_followup_date.value = todayIso();
  }
}

function getSelectedLead() {
  return state.leads.find((lead) => lead.id === state.selectedLeadId);
}

function getExecutives() {
  return Array.from(new Set(state.leads.map((lead) => lead.assigned_executive || "Unassigned"))).sort();
}

function nullable(value) {
  const normalized = String(value ?? "").trim();
  return normalized === "" ? null : normalized;
}

function formatCurrency(value) {
  if (value === null || value === undefined || value === "") return "-";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value));
}

function formatDate(value) {
  if (!value) return "-";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  if (!year || !month || !day) return "-";
  return `${day}-${month}-${year}`;
}

function renderToast() {
  if (!state.toast) return "";
  return `<div class="toast ${state.toast.type}">${escapeHtml(state.toast.message)}</div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function exportToCsv(filename, headers, rows) {
  const csvContent = [
    headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(","),
    ...rows.map(row => row.map(cell => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
  ].join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportLeadsToCsv() {
  const visibleLeads = applyTableFilters(filterLeadsByView(state.leads, state.route), state.filters);
  const headers = [
    "Customer Name",
    "Current Insurer",
    "Mobile Number",
    "Vehicle Number",
    "Model",
    "Variant",
    "Expiry Date",
    "Days Left",
    "Priority",
    "Status",
    "Next Action",
    "Assigned Executive",
    "Remarks"
  ];
  const rows = visibleLeads.map(lead => {
    const dec = decorateLead(lead);
    return [
      dec.customer_name,
      dec.current_insurer,
      dec.mobile_number,
      dec.vehicle_number,
      dec.model,
      dec.variant,
      dec.policy_expiry_date,
      dec.days_left,
      dec.priority,
      dec.current_status,
      dec.next_action_label,
      dec.assigned_executive,
      dec.remarks
    ];
  });
  const dateStr = new Date().toISOString().slice(0, 10);
  exportToCsv(`irfd_leads_${state.route}_${dateStr}.csv`, headers, rows);
}

function exportActivitiesToCsv() {
  const headers = ["Timestamp", "Action", "Details", "Performed By", "Lead ID"];
  const rows = state.activities.map(act => [
    act.timestamp,
    act.action,
    act.details,
    act.user,
    act.leadId || ""
  ]);
  const dateStr = new Date().toISOString().slice(0, 10);
  exportToCsv(`irfd_activity_log_${dateStr}.csv`, headers, rows);
}
