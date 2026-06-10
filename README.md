#  Automated Data Pipeline: Google Sheets to OpenSearch Unified Sync

An automated data engineering pipeline that synchronizes, normalizes, and reconciles master inventory data and OCR records into an OpenSearch cluster. Built using **Node.js** and orchestrated via **GitHub Actions** for hands-free daily tracking.

##  Key Features

* **Automated Scheduling (Cron Jobs):** Workflows trigger automatically during off-peak hours (PHT) using GitHub Actions schedules to maintain fresh datasets without manual intervention.
* **Data Aggregation & Cross-Index Reconciliation:** Features a high-performance lookup mechanism (`unified-recon.js`) that processes and cross-references data across 4 distinct asset management sources based on serial number mapping.
* **Failsafe Edge-Case Handling:** Implements data validation logic to clean up formatting discrepancies (e.g., standardizing empty spaces, 'none', or hyphens into clean data blocks) and bypass index dynamic mapping rejection errors.
* **Optimized Bulk Upserts:** Processes records dynamically using OpenSearch Bulk API chunks (up to 2,000 documents per batch) with real-time feedback logs to maximize efficiency and avoid runner time-outs.

---

##  System Architecture & Workflow

1. **Ingestion Layer:** Reads live operational asset layers from Google Sheets tabs (`OCR`, `MATCH`, `MISSING`) via the Google Sheets and Google Auth API.
2. **Processing Layer (Node.js):** Cleans, converts types, standardizes key attributes, and normalizes inputs to prepare them for synchronization.
3. **Storage & Monitoring Layer:** Resets target indices cleanly and bulk-uploads fresh data into your OpenSearch cluster, yielding a unified view (`psc-recon-devices-unified`).

---

##  Tech Stack

* **Runtime Environment:** Node.js (v20)
* **Database Cluster:** OpenSearch (Client `@opensearch-project/opensearch`)
* **Integrations:** Google Auth Library, Google Spreadsheet API, ExcelJS
* **Orchestration & CI/CD:** GitHub Actions

---

##  Environment Variables Required

To run this pipeline successfully inside GitHub Actions, ensure the following keys are added to your **Repository Secrets**:

* `SERVICE_ACCOUNT_JSON` - Complete Google Cloud service account JSON credentials.
* `OPENSEARCH_URL` - Endpoint URL of your active OpenSearch cluster.
* `OPENSEARCH_USERNAME` & `OPENSEARCH_PASSWORD` - Administrative cluster access credentials.
* `GOOGLE_SHEET_ID_INPUT` & `GOOGLE_SHEET_ID_OCR` - Target Google Sheets IDs for data fetching.
* `INDEX_NAME_INPUT` & `INDEX_NAME_OCR` - Destination index identifiers.

---

##  Automated Workflows Configuration

The automation routines run sequentially every morning (PHT):
* **Input Sync (`sync-input.yml`):** Automatically processes master files at 3:00 AM PHT (`0 19 * * *`).
* **OCR Transmittal Sync (`sync-ocr.yml`):** Runs at 3:15 AM PHT (`15 19 * * *`).
* **Unified Device Reconciliation (`sync-unified.yml`):** Combines and evaluates duplicate layers at 4:00 AM PHT (`0 20 * * *`).
