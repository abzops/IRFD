import assert from "node:assert/strict";
import {
  calculateDashboardCounts,
  calculateFunnel,
  calculateStaffPerformance,
  decorateLead,
  filterLeadsByView,
  getPriority
} from "../assets/js/logic.js";

const today = "2026-06-03";

const leads = [
  {
    id: "1",
    customer_name: "Urgent Customer",
    current_status: "Quote Sent",
    policy_expiry_date: "2026-06-09",
    next_followup_date: "2026-06-03",
    assigned_executive: "Staff A",
    quote_sent_date: "2026-06-02",
    renewal_quote_amount: 10000
  },
  {
    id: "2",
    customer_name: "Expired Customer",
    current_status: "Call Pending",
    policy_expiry_date: "2026-06-01",
    next_followup_date: "2026-06-03",
    assigned_executive: "Staff A",
    renewal_quote_amount: 12000
  },
  {
    id: "3",
    customer_name: "Renewed Customer",
    current_status: "Renewed",
    policy_expiry_date: "2026-06-10",
    next_followup_date: "2026-06-03",
    assigned_executive: "Staff A",
    renewal_quote_amount: 13000
  },
  {
    id: "4",
    customer_name: "Lost Customer",
    current_status: "Lost",
    policy_expiry_date: "2026-06-10",
    next_followup_date: "2026-06-03",
    assigned_executive: "Staff B",
    lost_reason: "Not Interested",
    customer_response: "Not Interested",
    renewal_quote_amount: 9000
  },
  {
    id: "5",
    customer_name: "Missing Action",
    current_status: "Interested",
    policy_expiry_date: "2026-06-20",
    next_followup_date: null,
    assigned_executive: "Staff B",
    renewal_quote_amount: 11000
  }
];

const followups = [
  { renewal_id: "1", followup_mode: "Call" },
  { renewal_id: "2", followup_mode: "Call" },
  { renewal_id: "3", followup_mode: "WhatsApp" },
  { renewal_id: "5", followup_mode: "Call" }
];

assert.equal(getPriority("Quote Sent", "2026-06-09", today), "Urgent", "6-day expiry should be urgent");
assert.equal(getPriority("Call Pending", "2026-06-01", today), "Critical", "expired policy should be critical");

const dueToday = filterLeadsByView(leads, "today", today);
assert.deepEqual(
  dueToday.map((lead) => lead.id).sort(),
  ["1", "2", "5"],
  "today view should include due active leads and action-missing leads only"
);

assert.equal(decorateLead(leads[4], today).next_action_label, "Action Missing", "missing active next follow-up should be visible");

const counts = calculateDashboardCounts(leads, today);
assert.equal(counts.expiringIn7Days, 1, "active non-expired leads expiring within 7 days should be counted");
assert.equal(counts.renewed, 1, "renewed card should count final renewals");
assert.equal(counts.lost, 1, "lost card should count lost leads");
assert.equal(counts.notInterested, 1, "not interested card should count lost reason");

const funnel = calculateFunnel(leads);
assert.equal(funnel.at(-1).count, 1, "funnel should end with renewed count");

const staff = calculateStaffPerformance(leads, followups);
const staffA = staff.find((row) => row.executive === "Staff A");
assert.equal(staffA.leads_assigned, 3, "staff assigned count should include all assigned leads");
assert.equal(staffA.renewed, 1, "staff renewed count should be calculated");
assert.equal(staffA.conversion_percentage, 33, "conversion should be renewed divided by assigned");

console.log("logic tests passed");
