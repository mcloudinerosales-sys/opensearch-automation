import 'dotenv/config';
import { Client } from '@opensearch-project/opensearch';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';

// 1. Configuration & Auth
const creds = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
const INDEX = process.env.INDEX_NAME_OCR;
const BATCH_SIZE = 1000; 

const client = new Client({
  node: process.env.OPENSEARCH_URL,
  auth: {
    username: process.env.OPENSEARCH_USERNAME,
    password: process.env.OPENSEARCH_PASSWORD,
  },
  ssl: { rejectUnauthorized: false },
});

const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly'
  ],
});

/**
 * NORMALIZE FUNCTION
 * Nililinis ang data at tinatanggal ang mga '-' or empty strings para maging null.
 */
function normalize(value) {
  if (value === 0) return 0;
  if (value === null || value === undefined) return null;
  
  const valStr = String(value).trim();
  const lowerVal = valStr.toLowerCase();

  if (lowerVal === '' || lowerVal === '-' || lowerVal === 'none' || lowerVal === 'n/a') {
    return null;
  }
  return valStr;
}

/**
 * DATE FORMATTER
 * Sinisiguro na laging "MMM d, yyyy @ HH:mm:ss.SSS" ang format.
 */
function formatToOpenSearchDate(val) {
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;

  const options = { month: 'short', day: 'numeric', year: 'numeric' };
  const datePart = d.toLocaleDateString('en-US', options);
  const timePart = d.toISOString().split('T')[1].replace('Z', '');
  
  return `${datePart} @ ${timePart}`;
}

async function processData(rows) {
  let batch = [];
  let totalProcessed = 0;
  const now = new Date().toISOString();
  const headers = rows[0]; 

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const obj = {};
    
    headers.forEach((key, index) => {
      if (key) {
        const cleanKey = key.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        let val = normalize(row[index]);

        const isDateField = cleanKey === 'date' || cleanKey === 'ocr_date';

        if (isDateField) {
          const formattedDate = val ? formatToOpenSearchDate(val) : null;
          if (formattedDate) obj[cleanKey] = formattedDate;
          // Note: If null ang date, hindi natin isasama ang field para iwas mapping error.
        } else {
          obj[cleanKey] = val || '-'; // Default sa hyphen kung null ang text fields
        }
      }
    });

    obj.source_type = 'OCR';
    obj.sync_timestamp = now;

    batch.push({ index: { _index: INDEX } });
    batch.push(obj);
    totalProcessed++;

    if (batch.length >= BATCH_SIZE * 2) {
      await sendBulk(batch);
      batch = [];
      console.log(`⏳ Progress: ${totalProcessed} records uploaded...`);
    }
  }

  if (batch.length > 0) {
    await sendBulk(batch);
  }
  console.log(`✅ Final Success! Total records handled: ${totalProcessed}`);
}

async function sendBulk(batch) {
  const response = await client.bulk({ refresh: true, body: batch });
  if (response.errors) {
    const erroredDocuments = response.items.filter(item => item.index && item.index.error);
    console.error(`❌ Found ${erroredDocuments.length} errors in this batch.`);
    // Opsyonal: I-log ang detalye ng error
    // console.error(JSON.stringify(erroredDocuments[0].index.error, null, 2));
  }
}

async function run() {
  try {
    console.log(`🚀 Starting OCR Sync for: ${INDEX}...`);

    // 1. Delete and Re-create Index (Warning: This wipes existing data)
    try { await client.indices.delete({ index: INDEX }); } catch (e) { console.log("Index not found, skipping delete."); }

    await client.indices.create({
      index: INDEX,
      body: {
        mappings: {
          properties: {
            "date": { 
              "type": "date", 
              "format": "MMM d, yyyy @ HH:mm:ss.SSS||strict_date_optional_time||epoch_millis" 
            },
            "ocr_date": { 
              "type": "date", 
              "format": "MMM d, yyyy @ HH:mm:ss.SSS||strict_date_optional_time||epoch_millis" 
            },
            "sync_timestamp": { "type": "date" },
            "mobile_number": { "type": "keyword" }, // Keyword para hindi mag-split ang numbers
            "serial_number": { "type": "keyword" }
          }
        }
      }
    });

    // 2. Fetch Data from Google Sheets
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();
    
    const sheet = doc.sheetsByTitle['OCR']; 
    if (sheet) {
      console.log(`📖 Reading GSheet tab: OCR...`);
      const rows = await sheet.getRows(); 
      // r._rawData ay array ng cells
      const rawRows = [sheet.headerValues, ...rows.map(r => r._rawData)];
      await processData(rawRows);
    } else {
      console.error('❌ Error: Tab "OCR" not found!');
    }
    
    console.log("🏁 SYNC COMPLETE!");
  } catch (error) {
    console.error('❌ Critical Error:', error);
  }
}

run();
