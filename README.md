# 🛡️ IRFD Insurance Renewal Dashboard

<div align="center">
  <img src="assets/images/logo.png" alt="IRFD Logo" width="120" style="margin-bottom: 20px; border-radius: 12px;"/>
  <p><strong>A Premium Minimalist SaaS Portal for Automated Insurance Renewal Follow-Ups & Lead Management</strong></p>

  [![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)](#)
  [![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)](#)
  [![JavaScript](https://img.shields.io/badge/ES6_JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](#)
  [![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](#)
</div>

---

## 🌟 Key Features

* **🎨 Sleek Dark-Mode Design**
  * Built using a custom, premium design system featuring smooth gradients, modern typography (Outfit & Plus Jakarta Sans), and glassmorphism.
  * Responsive table layout optimized to eliminate layout shifts, cell wrapping, and overflows.

* **⚡ Interactive Lead Management**
  * Advanced filter-bar allowing search and real-time filtering by status, priority, and assigned executive.
  * **Hover Action Overlay**: Contextual action shortcuts (Call, WhatsApp, Edit) slide in gracefully over rows on hover, saving column space and optimizing layout width.
  * **Interactive Drawer Details**: Slide-out panel categorized into detailed tabs: Client Info, Vehicle Info, Activity Logs, and edit options.

* **📤 Excel-Compatible Data Export**
  * Export filtered leads lists directly from the Leads view toolbar with one click.
  * Export complete System Activity Logs into double-quote escaped, Excel-compatible CSVs.
  * Pre-formatted database upload template (`renewal_leads_template.csv`) provided for easy lead ingestion.

* **🔑 Minimalist Auth & Configuration Setup**
  * Lightweight Setup Portal for secure browser-based Supabase configuration.
  * Clean, minimal sign-in and sign-up interfaces using project styling variables.

---

## 📂 Codebase Structure

```text
├── assets/
│   ├── css/
│   │   └── styles.css          # Core design system, variables, layouts, and animations
│   ├── images/
│   │   └── logo.png            # App branding logo
│   └── js/
│       ├── app.js              # Application state, router, and UI components
│       └── logic.js            # Pure business logic and utilities
├── supabase/
│   └── schema.sql              # Supabase tables, views, RLS, and RPC functions
├── tests/
│   └── logic.test.mjs          # Local automated logic verification tests
├── index.html                  # Main application boot screen and script imports
├── renewal_leads_template.csv  # Import template for database renewals
└── package.json                # Project and test configuration
```

---

## 🚀 Quick Start (Local Development)

### 1. Run the Local Server
Spawn a lightweight server in your terminal of choice:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

### 2. View in Browser
Open the following link to view the app:
👉 **[http://127.0.0.1:4173](http://127.0.0.1:4173)**

> [!TIP]
> To preview and test all dashboard interfaces locally **without** setting up Supabase credentials, append the demo query parameter:
> 👉 **[http://127.0.0.1:4173/?demo=1](http://127.0.0.1:4173/?demo=1)**

---

## ⚙️ Supabase Integration & Schema Setup

To wire up the live system database:

1. **Create a Supabase Project**: Set up a new project in your [Supabase Dashboard](https://supabase.com).
2. **Execute Database Schema**: Copy the contents of `supabase/schema.sql`, open the **SQL Editor** in Supabase, and run the script to initialize tables, RLS policies, views, and RPC helpers.
3. **Register Staff Users**: Manually create credentials under the **Authentication** tab of your Supabase project.
4. **Configure Dashboard**: Open your local instance of the dashboard, enter the project's **Supabase URL** and **Anon Public Key** in the Setup Panel, and click **Save**.

> [!IMPORTANT]
> The browser application runs entirely client-side and requires only the **Anon Public Key**. Do not expose or write your Supabase `service-role` key inside `index.html` or local storage configuration.

---

## 🧪 Testing and Verification

Verify state logic, formats, and regression assertions locally:

```powershell
# Run the logic test suite
node tests/logic.test.mjs

# Verify git formatting status
git diff --check
```
