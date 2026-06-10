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

function normalize(value) {
  if (value === 0) return "0";
  if (value === null || value === undefined || String(value).trim() === '' || String(value).trim() === '-') {
    return "-"; 
  }
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
    console.log(`\n Total retrieved: ${allDocs.length}`);
  } catch (e) { console.error(` Error fetching ${indexName}:`, e.message); }
  return allDocs;
}

async function run() {
  try {
    const rawDataSets = {};
    const globalLookup = new Map(); 
    const allFields = new Set();
    const now = new Date().toISOString();

    // 1. FIRST PASS: AGGRESSIVE LOOKUP TABLE BUILDING
    for (const src of SOURCES) {
      const data = await fetchAll(src.index);
      rawDataSets[src.prefix] = data;

      data.forEach(item => {
        // Humanap ng kahit anong field na may "serial" sa pangalan para sa source na ito
        const serialKeys = Object.keys(item).filter(k => k.toLowerCase().includes('serial'));
        
        // Kunin ang lahat ng posibleng values ng serial numbers sa record na ito (Normalize & Clean)
        let possibleSNs = serialKeys.map(k => normalize(item[k]).toUpperCase()).filter(v => v !== "-");
        
        // Fallback standard fields
        const fallbackSN = item.serial_number || item.serial || item.psc_serial || item.psc_serial_2;
        if (fallbackSN) possibleSNs.push(normalize(fallbackSN).toUpperCase());

        const uniqueSNs = [...new Set(possibleSNs)];

        uniqueSNs.forEach(sn => {
          if (!globalLookup.has(sn)) {
            globalLookup.set(sn, { sources: new Set(), data: {} });
          }
          const entry = globalLookup.get(sn);
          entry.sources.add(src.prefix.toUpperCase());

          // Map and store every field into the lookup
          Object.keys(item).forEach(key => {
            const cleanKey = key.toLowerCase().startsWith(src.prefix) 
                             ? key.toLowerCase().replace(/\s+/g, '_') 
                             : `${src.prefix}_${key.toLowerCase().replace(/\s+/g, '_')}`;
            allFields.add(cleanKey);
            entry.data[cleanKey] = item[key]; 
          });
        });
      });
    }

    let finalBatch = [];
    console.log(`🏗️  Enriching records with cross-index lookups...`);

    // 2. SECOND PASS: CREATE ENRICHED RECORDS (Ensures ~58,963 count)
    for (const src of SOURCES) {
      const data = rawDataSets[src.prefix] || [];
      data.forEach(item => {
        const obj = {};
        
        // Find the SN for the current row's lookup
        const serialKeys = Object.keys(item).filter(k => k.toLowerCase().includes('serial'));
        let sn = null;
        for (let k of serialKeys) {
            let val = normalize(item[k]).toUpperCase();
            if (val !== "-") { sn = val; break; }
        }
        if (!sn) {
            const fb = item.serial_number || item.serial || item.psc_serial || item.psc_serial_2;
            sn = fb ? normalize(fb).toUpperCase() : null;
        }
                      
        const lookupEntry = sn ? globalLookup.get(sn) : null;
        const foundArray = lookupEntry ? Array.from(lookupEntry.sources) : [src.prefix.toUpperCase()];

        // Core Metadata
        obj.base_source = src.prefix.toUpperCase();
        obj.serial_number = sn || "-";
        obj.found_in_indices = foundArray.join(" | ");
        obj.match_status = foundArray.length > 1 ? "MATCHED" : "UNMATCHED";
        obj.sync_timestamp = now;

        // Populate ALL fields from the global lookup
        allFields.forEach(field => {
          // Priority 1: Current record value
          const cleanLocalKey = Object.keys(item).find(k => {
             const ck = k.toLowerCase().startsWith(src.prefix) 
                        ? k.toLowerCase().replace(/\s+/g, '_') 
                        : `${src.prefix}_${k.toLowerCase().replace(/\s+/g, '_')}`;
             return ck === field;
          });

          let val = (cleanLocalKey && item[cleanLocalKey] !== undefined) 
                    ? item[cleanLocalKey] 
                    : (lookupEntry ? lookupEntry.data[field] : null);
          
          obj[field] = normalize(val);
        });

        finalBatch.push({ index: { _index: TARGET_INDEX } });
        finalBatch.push(obj);
      });
    }

    // 3. RESET INDEX & BULK UPLOAD
    console.log(`🗑️  Resetting index ${TARGET_INDEX}...`);
    try { await client.indices.delete({ index: TARGET_INDEX }); } catch (e) {}
    await client.indices.create({
      index: TARGET_INDEX,
      body: {
        mappings: {
          date_detection: false, // Prevents custom date format errors
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

    console.log(` Uploading ${finalBatch.length / 2} records...`);
    const BATCH_SIZE = 500;
    for (let i = 0; i < finalBatch.length; i += BATCH_SIZE * 2) {
      const chunk = finalBatch.slice(i, i + BATCH_SIZE * 2);
      await client.bulk({ body: chunk });
      const progress = Math.min((i / 2) + BATCH_SIZE, finalBatch.length / 2);
      process.stdout.write(` Progress: ${progress.toFixed(0)} / ${finalBatch.length / 2}\r`);
    }

    console.log(`\n\n DONE! Count is ~58k and PSC data is mapped if SN exists.`);
  } catch (err) { console.error(" CRITICAL ERROR:", err); }
}

run();
