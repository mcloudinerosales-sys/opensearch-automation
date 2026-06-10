import 'dotenv/config';
import { Client } from '@opensearch-project/opensearch';

const client = new Client({
  node: process.env.OPENSEARCH_URL,
  auth: { 
    username: process.env.OPENSEARCH_USERNAME, 
    password: process.env.OPENSEARCH_PASSWORD 
  },
  ssl: { rejectUnauthorized: false },
});

const TARGET_INDEX = "psc-recon-devices-unified";
const SOURCES = [
  { prefix: "ocr", index: "psc-recon-ocr-transmittal-returns-latest" },
  { prefix: "atis", index: "psc-recon-atis-assets-master" },
  { prefix: "atis3", index: "psc-recon-atis3-assets-master" },
  { prefix: "psc", index: "psc-recon-devices-latest" }
];

// --- NORMALIZATION FUNCTIONS (KATULAD NG FORMAT MO) ---
function normalize(value) {
  if (value === 0) return 0;
  if (value === null || value === undefined || String(value).trim() === '' || String(value).trim() === '-') {
    return null; 
  }
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

async function fetchAll(indexName) {
  console.log(`📡 Fetching data from ${indexName}...`);
  let allDocs = [];
  try {
    const response = await client.search({
      index: indexName, 
      scroll: '10m', 
      size: 5000,
      body: { query: { match_all: {} } }
    });
    
    let scrollId = response.body._scroll_id;
    let hits = response.body.hits.hits;

    while (hits && hits.length) {
      allDocs.push(...hits.map(h => h._source));
      process.stdout.write(`   📥 Downloaded ${allDocs.length} records...\r`);
      const scrollRes = await client.scroll({ scroll_id: scrollId, scroll: '10m' });
      scrollId = scrollRes.body._scroll_id;
      hits = scrollRes.body.hits.hits;
    }
    console.log(`\n✅ Total retrieved: ${allDocs.length}`);
  } catch (e) { console.error(`❌ Error fetching ${indexName}:`, e.message); }
  return allDocs;
}

async function run() {
  try {
    const snLookup = new Map();
    const rawDataSets = {};
    const now = new Date().toISOString();

    // 1. GATHER DATA & PRE-SCAN FOR MATCHES
    for (const src of SOURCES) {
      const data = await fetchAll(src.index);
      rawDataSets[src.prefix] = data;

      data.forEach(item => {
        const rawSN = item[`${src.prefix}_serial_number`] || item[`${src.prefix}_serial`] || 
                      item.serial_number || item.serial || item.psc_serial || item.psc_serial_2;
        if (rawSN && rawSN !== "-") {
          const sn = String(rawSN).trim().toUpperCase();
          if (!snLookup.has(sn)) snLookup.set(sn, new Set());
          snLookup.get(sn).add(src.prefix.toUpperCase());
        }
      });
    }

    let finalBatch = [];
    console.log("🏗️  Processing and Normalizing records...");

    // 2. PROCESS RECORDS WITH NORMALIZATION
    for (const src of SOURCES) {
      const data = rawDataSets[src.prefix] || [];
      
      data.forEach(item => {
        const obj = {};
        const rawSN = item[`${src.prefix}_serial_number`] || item[`${src.prefix}_serial`] || 
                      item.serial_number || item.serial || item.psc_serial || item.psc_serial_2;
        const sn = rawSN ? String(rawSN).trim().toUpperCase() : "NO_SERIAL";

        // Reconciliation Meta
        const foundIn = snLookup.get(sn) || new Set([src.prefix.toUpperCase()]);
        const sourcesArray = Array.from(foundIn);

        obj.base_source = src.prefix.toUpperCase();
        obj.serial_number = sn;
        obj.found_in_indices = sourcesArray.join(" | ");
        obj.match_status = sourcesArray.length > 1 ? "MATCHED" : "UNMATCHED";
        obj.sync_timestamp = now;

        // Field Normalization Logic (KATULAD NG GUSTO MO)
        Object.keys(item).forEach(key => {
          const cleanKey = key.toLowerCase().startsWith(src.prefix) 
                           ? key.toLowerCase().replace(/\s+/g, '_') 
                           : `${src.prefix}_${key.toLowerCase().replace(/\s+/g, '_')}`;
          
          let val = normalize(item[key]);

          const isDateField = cleanKey.includes('timestamp') || 
                             cleanKey.includes('date') || 
                             cleanKey.includes('@') || 
                             cleanKey.includes('ingested');

          if (val === null) {
            if (isDateField) {
              obj[cleanKey] = now; // Lagyan ng current time kung blanko ang date
            } else {
              obj[cleanKey] = '-'; 
            }
          } else {
            obj[cleanKey] = val;
          }
        });

        finalBatch.push({ index: { _index: TARGET_INDEX } });
        finalBatch.push(obj);
      });
    }

    // 3. RESET INDEX & APPLY MAPPING
    console.log(`🗑️  Resetting ${TARGET_INDEX}...`);
    try { await client.indices.delete({ index: TARGET_INDEX }); } catch (e) {}
    await client.indices.create({
      index: TARGET_INDEX,
      body: {
        mappings: {
          dynamic_templates: [{
            strings_as_keywords: {
              match_mapping_type: "string",
              mapping: { type: "keyword", ignore_above: 256 }
            }
          }],
          properties: { sync_timestamp: { type: "date" } }
        }
      }
    });

    // 4. BULK UPLOAD (BATCHING)
    console.log(`🚀 Uploading ${finalBatch.length / 2} records...`);
    const BATCH_SIZE = 2000;
    for (let i = 0; i < finalBatch.length; i += BATCH_SIZE * 2) {
      const chunk = finalBatch.slice(i, i + BATCH_SIZE * 2);
      const { body: result } = await client.bulk({ body: chunk });
      
      if (result.errors) {
        const errorSample = result.items.find(item => item.index && item.index.error);
        console.error(`❌ Bulk Error:`, JSON.stringify(errorSample.index.error, null, 2));
      }
      process.stdout.write(`📦 Progress: ${Math.min((i / 2) + BATCH_SIZE, finalBatch.length / 2)} / ${finalBatch.length / 2}\r`);
    }

    console.log(`\n✅ RECONCILIATION COMPLETE!`);
  } catch (err) { console.error("❌ CRITICAL ERROR:", err); }
}

run();
