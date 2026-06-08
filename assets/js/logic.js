const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const ACTIVE_STATUSES = [
  "New Lead",
  "Call Pending",
  "Contacted",
  "Not Reachable",
  "Quote Requested",
  "Quote Sent",
  "Follow-up Pending",
  "Interested",
  "Payment Pending"
];

export const CLOSED_STATUSES = ["Renewed", "Lost", "Invalid Data"];

export const STATUS_OPTIONS = [...ACTIVE_STATUSES, ...CLOSED_STATUSES];

export const PAYMENT_STATUS_OPTIONS = [
  "Not Started",
  "Pending",
  "Collected",
  "Failed",
  "Refunded"
];

export const LOST_REASONS = [
  "Premium High",
  "Renewed Elsewhere",
  "Not Interested",
  "Vehicle Sold",
  "Not Reachable",
  "Wrong Number",
  "Only Third Party"
];

export const FOLLOWUP_MODES = ["Call", "WhatsApp", "SMS", "Email", "In Person"];

export function todayIso(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  return null;
}

export function addDays(baseDate, days) {
  const base = toDateOnly(baseDate) || toDateOnly(todayIso());
  const date = new Date(base);
  date.setDate(date.getDate() + Number(days));
  return todayIso(date);
}

export function getDaysLeft(policyExpiryDate, today = todayIso()) {
  const expiry = toDateOnly(policyExpiryDate);
  const current = toDateOnly(today);
  if (!expiry || !current) return null;
  return Math.round((expiry.getTime() - current.getTime()) / MS_PER_DAY);
}

export function isClosedStatus(status) {
  return CLOSED_STATUSES.includes(status);
}

export function getPriority(status, policyExpiryDate, today = todayIso()) {
  if (status === "Renewed") return "Renewed";
  if (status === "Lost") return "Lost";
  if (status === "Invalid Data") return "Closed";

  const daysLeft = getDaysLeft(policyExpiryDate, today);
  if (daysLeft === null) return "Unknown";
  if (daysLeft < 0) return "Critical";
  if (daysLeft <= 7) return "Urgent";
  if (daysLeft <= 15) return "High";
  if (daysLeft <= 30) return "Medium";
  return "Low";
}

export function getPriorityClass(priority) {
  return String(priority || "unknown").toLowerCase().replace(/\s+/g, "-");
}

export function isActionMissing(lead) {
  return !isClosedStatus(lead.current_status) && !lead.next_followup_date;
}

export function suggestedNextAction(status) {
  const actions = {
    "New Lead": "First call",
    "Call Pending": "Call customer",
    Contacted: "Update response",
    "Not Reachable": "Retry call",
    "Quote Requested": "Prepare quote",
    "Quote Sent": "Call for confirmation",
    "Follow-up Pending": "Follow up",
    Interested: "Push for payment",
    "Payment Pending": "Collect payment",
    Renewed: "Share policy copy",
    Lost: "Review lost reason",
    "Invalid Data": "Verify record"
  };
  return actions[status] || "Follow up";
}

export function decorateLead(lead, today = todayIso()) {
  const daysLeft = getDaysLeft(lead.policy_expiry_date, today);
  const priority = lead.priority || getPriority(lead.current_status, lead.policy_expiry_date, today);
  const actionMissing = lead.action_missing ?? isActionMissing(lead);
  return {
    ...lead,
    days_left: lead.days_left ?? daysLeft,
    priority,
    priority_class: getPriorityClass(priority),
    action_missing: actionMissing,
    next_action_label: actionMissing ? "Action Missing" : lead.next_action || suggestedNextAction(lead.current_status)
  };
}

export function isDueToday(lead, today = todayIso()) {
  const decorated = decorateLead(lead, today);
  if (isClosedStatus(decorated.current_status)) return false;
  if (decorated.action_missing) return true;
  const nextFollowup = toDateOnly(decorated.next_followup_date);
  const current = toDateOnly(today);
  return Boolean(nextFollowup && current && nextFollowup.getTime() <= current.getTime());
}

export function filterLeadsByView(leads, view, today = todayIso()) {
  const decorated = leads.map((lead) => decorateLead(lead, today));

  switch (view) {
    case "today":
      return decorated.filter((lead) => isDueToday(lead, today));
    case "expiring":
      return decorated.filter((lead) => !isClosedStatus(lead.current_status) && lead.days_left >= 0 && lead.days_left <= 30);
    case "quote":
      return decorated.filter((lead) => !isClosedStatus(lead.current_status) && (lead.current_status === "Quote Sent" || Boolean(lead.quote_sent_date)));
    case "payment":
      return decorated.filter((lead) => !isClosedStatus(lead.current_status) && (lead.current_status === "Payment Pending" || lead.payment_status === "Pending"));
    case "renewed":
      return decorated.filter((lead) => lead.current_status === "Renewed");
    case "lost":
      return decorated.filter((lead) => lead.current_status === "Lost");
    default:
      return decorated;
  }
}

export function applyTableFilters(leads, filters = {}) {
  const query = String(filters.query || "").trim().toLowerCase();
  const status = filters.status || "";
  const executive = filters.executive || "";
  const sortBy = filters.sortBy || "";

  let filtered = leads.filter((lead) => {
    const matchesQuery =
      !query ||
      [
        lead.customer_name,
        lead.mobile_number,
        lead.vehicle_number,
        lead.model,
        lead.current_insurer,
        lead.assigned_executive
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    const matchesStatus = !status || lead.current_status === status;
    const matchesExecutive = !executive || (lead.assigned_executive || "Unassigned") === executive;
    return matchesQuery && matchesStatus && matchesExecutive;
  });

  if (sortBy) {
    filtered.sort((a, b) => {
      if (sortBy === "expiry_asc") {
        const dateA = a.policy_expiry_date ? new Date(a.policy_expiry_date) : new Date(0);
        const dateB = b.policy_expiry_date ? new Date(b.policy_expiry_date) : new Date(0);
        return dateA - dateB;
      }
      if (sortBy === "expiry_desc") {
        const dateA = a.policy_expiry_date ? new Date(a.policy_expiry_date) : new Date(0);
        const dateB = b.policy_expiry_date ? new Date(b.policy_expiry_date) : new Date(0);
        return dateB - dateA;
      }
      if (sortBy === "days_asc") {
        const valA = (a.days_left !== null && a.days_left !== undefined) ? a.days_left : Infinity;
        const valB = (b.days_left !== null && b.days_left !== undefined) ? b.days_left : Infinity;
        return valA - valB;
      }
      if (sortBy === "days_desc") {
        const valA = (a.days_left !== null && a.days_left !== undefined) ? a.days_left : -Infinity;
        const valB = (b.days_left !== null && b.days_left !== undefined) ? b.days_left : -Infinity;
        return valB - valA;
      }
      if (sortBy === "priority_asc" || sortBy === "priority_desc") {
        const priorityRank = { "critical": 5, "urgent": 4, "high": 3, "medium": 2, "low": 1 };
        const rankA = priorityRank[String(a.priority || "").toLowerCase()] ?? 0;
        const rankB = priorityRank[String(b.priority || "").toLowerCase()] ?? 0;
        return sortBy === "priority_asc" ? rankA - rankB : rankB - rankA;
      }
      if (sortBy === "customer_asc") {
        return String(a.customer_name || "").localeCompare(String(b.customer_name || ""));
      }
      if (sortBy === "customer_desc") {
        return String(b.customer_name || "").localeCompare(String(a.customer_name || ""));
      }
      return 0;
    });
  }

  return filtered;
}

export function calculateDashboardCounts(leads, today = todayIso()) {
  const decorated = leads.map((lead) => decorateLead(lead, today));
  const currentDate = toDateOnly(today);

  return {
    totalRenewalLeads: decorated.length,
    expiringThisMonth: decorated.filter((lead) => {
      const expiry = toDateOnly(lead.policy_expiry_date);
      return (
        expiry &&
        currentDate &&
        !isClosedStatus(lead.current_status) &&
        expiry.getMonth() === currentDate.getMonth() &&
        expiry.getFullYear() === currentDate.getFullYear()
      );
    }).length,
    expiringIn7Days: decorated.filter((lead) => !isClosedStatus(lead.current_status) && lead.days_left >= 0 && lead.days_left <= 7).length,
    followUpDueToday: decorated.filter((lead) => isDueToday(lead, today)).length,
    quoteSent: decorated.filter((lead) => lead.current_status === "Quote Sent" || Boolean(lead.quote_sent_date)).length,
    interestedCustomers: decorated.filter((lead) => ["Interested", "Payment Pending", "Renewed"].includes(lead.current_status)).length,
    notInterested: decorated.filter((lead) => lead.current_status === "Lost" && (lead.lost_reason === "Not Interested" || lead.customer_response === "Not Interested")).length,
    renewed: decorated.filter((lead) => lead.current_status === "Renewed").length,
    lost: decorated.filter((lead) => lead.current_status === "Lost").length,
    pendingFollowup: decorated.filter((lead) => !isClosedStatus(lead.current_status) && ["Follow-up Pending", "Quote Sent", "Interested", "Not Reachable"].includes(lead.current_status)).length,
    actionMissing: decorated.filter((lead) => lead.action_missing).length
  };
}

function countAtStage(leads, stage) {
  const rank = {
    "New Lead": 0,
    "Call Pending": 0,
    "Not Reachable": 1,
    Contacted: 1,
    "Quote Requested": 1,
    "Quote Sent": 2,
    "Follow-up Pending": 2,
    Interested: 3,
    "Payment Pending": 4,
    Renewed: 5,
    Lost: 1,
    "Invalid Data": 0
  };
  return leads.filter((lead) => (rank[lead.current_status] ?? 0) >= stage).length;
}

export function calculateFunnel(leads) {
  return [
    { stage: "Total Leads", count: leads.length },
    { stage: "Contacted", count: countAtStage(leads, 1) },
    { stage: "Quote Sent", count: countAtStage(leads, 2) },
    { stage: "Interested", count: countAtStage(leads, 3) },
    { stage: "Payment Pending", count: countAtStage(leads, 4) },
    { stage: "Renewed", count: leads.filter((lead) => lead.current_status === "Renewed").length }
  ];
}

export function calculateStaffPerformance(leads, followups = []) {
  const groups = new Map();

  leads.forEach((lead) => {
    const name = lead.assigned_executive || "Unassigned";
    if (!groups.has(name)) {
      groups.set(name, {
        executive: name,
        leads_assigned: 0,
        calls_done: 0,
        quotes_sent: 0,
        renewed: 0,
        lost: 0,
        conversion_percentage: 0
      });
    }

    const group = groups.get(name);
    group.leads_assigned += 1;
    if (lead.current_status === "Quote Sent" || lead.quote_sent_date) group.quotes_sent += 1;
    if (lead.current_status === "Renewed") group.renewed += 1;
    if (lead.current_status === "Lost") group.lost += 1;
  });

  followups.forEach((followup) => {
    const lead = leads.find((item) => item.id === followup.renewal_id);
    if (!lead) return;
    const name = lead.assigned_executive || "Unassigned";
    const group = groups.get(name);
    if (group && followup.followup_mode === "Call") group.calls_done += 1;
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    conversion_percentage: group.leads_assigned ? Math.round((group.renewed / group.leads_assigned) * 100) : 0
  }));
}

export function calculateInsurerPerformance(leads) {
  const groups = new Map();

  leads.forEach((lead) => {
    const insurer = lead.current_insurer || "Unknown";
    if (!groups.has(insurer)) {
      groups.set(insurer, {
        insurance_company: insurer,
        leads: 0,
        quotes_sent: 0,
        renewed: 0,
        avg_premium: 0,
        conversion_percentage: 0,
        premium_total: 0,
        premium_count: 0
      });
    }

    const group = groups.get(insurer);
    group.leads += 1;
    if (lead.current_status === "Quote Sent" || lead.quote_sent_date) group.quotes_sent += 1;
    if (lead.current_status === "Renewed") group.renewed += 1;
    if (Number(lead.renewal_quote_amount) > 0) {
      group.premium_total += Number(lead.renewal_quote_amount);
      group.premium_count += 1;
    }
  });

  return Array.from(groups.values()).map((group) => ({
    insurance_company: group.insurance_company,
    leads: group.leads,
    quotes_sent: group.quotes_sent,
    renewed: group.renewed,
    avg_premium: group.premium_count ? Math.round(group.premium_total / group.premium_count) : 0,
    conversion_percentage: group.leads ? Math.round((group.renewed / group.leads) * 100) : 0
  }));
}

export function calculateLostReasonSummary(leads) {
  const groups = new Map();
  leads
    .filter((lead) => lead.current_status === "Lost")
    .forEach((lead) => {
      const reason = lead.lost_reason || "Unspecified";
      groups.set(reason, (groups.get(reason) || 0) + 1);
    });
  return Array.from(groups.entries()).map(([lost_reason, count]) => ({ lost_reason, count }));
}

export function calculateMonthlyReport(leads) {
  const groups = new Map();

  leads.forEach((lead) => {
    const basis = lead.renewal_date || lead.policy_expiry_date;
    const date = toDateOnly(basis);
    if (!date) return;
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    if (!groups.has(month)) {
      groups.set(month, { month, leads: 0, renewed: 0, lost: 0, premium_total: 0 });
    }
    const group = groups.get(month);
    group.leads += 1;
    if (lead.current_status === "Renewed") {
      group.renewed += 1;
      group.premium_total += Number(lead.renewal_quote_amount || 0);
    }
    if (lead.current_status === "Lost") group.lost += 1;
  });

  return Array.from(groups.values()).sort((a, b) => a.month.localeCompare(b.month));
}
